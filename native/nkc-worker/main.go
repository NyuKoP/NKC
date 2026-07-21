package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"sync"
)

type request struct {
	ID     string          `json:"id"`
	Method string          `json:"method"`
	Params json.RawMessage `json:"params"`
}

type response struct {
	ID     string `json:"id"`
	OK     bool   `json:"ok"`
	Result any    `json:"result,omitempty"`
	Error  string `json:"error,omitempty"`
}

type worker struct {
	queueMu   sync.RWMutex
	queue     *queueStore
	transport *transportEngine
	receive   *receiveManager
}

func (w *worker) getQueue() *queueStore {
	w.queueMu.RLock()
	defer w.queueMu.RUnlock()
	return w.queue
}

func decodeParams[T any](raw json.RawMessage) (T, error) {
	var value T
	if len(raw) == 0 {
		return value, nil
	}
	err := json.Unmarshal(raw, &value)
	return value, err
}

func (w *worker) handle(req request) (any, error) {
	switch req.Method {
	case "health":
		return map[string]any{"version": 1, "features": []string{"file", "queue", "scheduler", "transport"}}, nil
	case "file.inspect":
		params, err := decodeParams[fileInspectParams](req.Params)
		if err != nil {
			return nil, err
		}
		return inspectFile(params)
	case "file.chunk":
		params, err := decodeParams[fileChunkParams](req.Params)
		if err != nil {
			return nil, err
		}
		return readFileChunk(params)
	case "file.receive.init":
		params, err := decodeParams[receiveInitParams](req.Params)
		if err != nil {
			return nil, err
		}
		return w.receive.init(params)
	case "file.receive.write":
		params, err := decodeParams[receiveWriteParams](req.Params)
		if err != nil {
			return nil, err
		}
		return w.receive.write(params)
	case "file.receive.checkpoint":
		params, err := decodeParams[receiveIDParams](req.Params)
		if err != nil {
			return nil, err
		}
		return w.receive.checkpoint(params.TransferID)
	case "file.receive.finalize":
		params, err := decodeParams[receiveIDParams](req.Params)
		if err != nil {
			return nil, err
		}
		return w.receive.finalize(params.TransferID)
	case "file.receive.abort":
		params, err := decodeParams[receiveIDParams](req.Params)
		if err != nil {
			return nil, err
		}
		return w.receive.abort(params.TransferID)
	case "scheduler.plan":
		params, err := decodeParams[scheduleParams](req.Params)
		if err != nil {
			return nil, err
		}
		return planSchedule(params)
	case "transport.fetch":
		params, err := decodeParams[transportFetchParams](req.Params)
		if err != nil {
			return nil, err
		}
		return w.transport.fetch(params)
	case "transport.clearProxy":
		params, err := decodeParams[struct {
			ProxyURL string `json:"proxyUrl"`
		}](req.Params)
		if err != nil {
			return nil, err
		}
		w.transport.clearProxy(strings.TrimSpace(params.ProxyURL))
		return map[string]bool{"cleared": true}, nil
	case "transport.forward":
		params, err := decodeParams[transportForwardParams](req.Params)
		if err != nil {
			return nil, err
		}
		return w.forwardOnion(params)
	case "queue.init":
		params, err := decodeParams[queueInitParams](req.Params)
		if err != nil {
			return nil, err
		}
		store, err := openQueueStore(params.Path, params.LegacySnapshot, params.LegacyJournal)
		if err != nil {
			return nil, err
		}
		w.queueMu.Lock()
		w.queue = store
		w.queueMu.Unlock()
		return map[string]bool{"initialized": true}, nil
	case "queue.setFriends":
		queue := w.getQueue()
		if queue == nil {
			return nil, fmt.Errorf("queue_not_initialized")
		}
		params, err := decodeParams[setFriendsParams](req.Params)
		if err != nil {
			return nil, err
		}
		return map[string]bool{"updated": true}, queue.setFriends(params.Friends)
	case "queue.enqueue":
		queue := w.getQueue()
		if queue == nil {
			return nil, fmt.Errorf("queue_not_initialized")
		}
		params, err := decodeParams[enqueueParams](req.Params)
		if err != nil {
			return nil, err
		}
		return queue.enqueue(params)
	case "queue.list":
		queue := w.getQueue()
		if queue == nil {
			return nil, fmt.Errorf("queue_not_initialized")
		}
		return queue.list(), nil
	case "queue.setProxy":
		queue := w.getQueue()
		if queue == nil {
			return nil, fmt.Errorf("queue_not_initialized")
		}
		params, err := decodeParams[setProxyParams](req.Params)
		if err != nil {
			return nil, err
		}
		queue.setProxy(params.ProxyURL)
		return map[string]bool{"updated": true}, nil
	case "queue.flush":
		queue := w.getQueue()
		if queue == nil {
			return nil, fmt.Errorf("queue_not_initialized")
		}
		params, err := decodeParams[flushParams](req.Params)
		if err != nil {
			return nil, err
		}
		return queue.flush(params)
	default:
		return nil, fmt.Errorf("unknown_method:%s", req.Method)
	}
}

func main() {
	scanner := bufio.NewScanner(os.Stdin)
	scanner.Buffer(make([]byte, 64*1024), 32*1024*1024)
	encoder := json.NewEncoder(os.Stdout)
	w := &worker{transport: newTransportEngine(), receive: newReceiveManager()}
	var outputMu sync.Mutex
	var requests sync.WaitGroup
	writeResponse := func(payload response) {
		outputMu.Lock()
		defer outputMu.Unlock()
		_ = encoder.Encode(payload)
	}
	handleRequest := func(req request) {
		result, err := w.handle(req)
		if err != nil {
			writeResponse(response{ID: req.ID, OK: false, Error: err.Error()})
			return
		}
		writeResponse(response{ID: req.ID, OK: true, Result: result})
	}
	queueRequests := make(chan request)
	requests.Add(1)
	go func() {
		defer requests.Done()
		for req := range queueRequests {
			handleRequest(req)
		}
	}()
	for scanner.Scan() {
		var req request
		if err := json.Unmarshal(scanner.Bytes(), &req); err != nil {
			writeResponse(response{OK: false, Error: "invalid_request"})
			continue
		}
		if strings.HasPrefix(req.Method, "queue.") {
			queueRequests <- req
			continue
		}
		requests.Add(1)
		go func(req request) {
			defer requests.Done()
			handleRequest(req)
		}(req)
	}
	close(queueRequests)
	requests.Wait()
}

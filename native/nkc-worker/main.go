package main

import (
	"bufio"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"strings"
	"sync"
)

type request struct {
	ID     string          `json:"id"`
	Method string          `json:"method"`
	Params json.RawMessage `json:"params"`
	Body   []byte          `json:"-"`
}

type binaryResponse struct {
	Result any
	Body   []byte
}

const maxFrameHeaderBytes = 1024 * 1024
const maxFrameBodyBytes = 32 * 1024 * 1024

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
		return map[string]any{"version": 2, "features": []string{"file", "queue", "scheduler", "transport", "binary-ipc"}}, nil
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
	case "file.chunk.binary":
		params, err := decodeParams[fileChunkParams](req.Params)
		if err != nil {
			return nil, err
		}
		metadata, body, err := readFileChunkBinary(params)
		if err != nil {
			return nil, err
		}
		return binaryResponse{Result: metadata, Body: body}, nil
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
	case "file.receive.write.binary":
		params, err := decodeParams[receiveWriteParams](req.Params)
		if err != nil {
			return nil, err
		}
		return w.receive.writeBinary(params.TransferID, params.Index, req.Body)
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
	case "transport.forward.binary":
		params, err := decodeParams[transportForwardParams](req.Params)
		if err != nil {
			return nil, err
		}
		if len(req.Body) == 0 {
			return nil, fmt.Errorf("missing_forward_payload")
		}
		if err := json.Unmarshal(req.Body, &params.Payload); err != nil {
			return nil, fmt.Errorf("invalid_forward_payload:%w", err)
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
	reader := bufio.NewReaderSize(os.Stdin, 64*1024)
	writer := bufio.NewWriterSize(os.Stdout, 64*1024)
	w := &worker{transport: newTransportEngine(), receive: newReceiveManager()}
	var outputMu sync.Mutex
	var requests sync.WaitGroup
	writeResponse := func(payload response, body []byte) {
		outputMu.Lock()
		defer outputMu.Unlock()
		header, err := json.Marshal(payload)
		if err != nil || len(header) > maxFrameHeaderBytes || len(body) > maxFrameBodyBytes {
			return
		}
		var prefix [8]byte
		binary.BigEndian.PutUint32(prefix[0:4], uint32(len(header)))
		binary.BigEndian.PutUint32(prefix[4:8], uint32(len(body)))
		if _, err = writer.Write(prefix[:]); err == nil {
			_, err = writer.Write(header)
		}
		if err == nil && len(body) > 0 {
			_, err = writer.Write(body)
		}
		if err == nil {
			_ = writer.Flush()
		}
	}
	handleRequest := func(req request) {
		result, err := w.handle(req)
		if err != nil {
			writeResponse(response{ID: req.ID, OK: false, Error: err.Error()}, nil)
			return
		}
		if binaryResult, ok := result.(binaryResponse); ok {
			writeResponse(response{ID: req.ID, OK: true, Result: binaryResult.Result}, binaryResult.Body)
			return
		}
		writeResponse(response{ID: req.ID, OK: true, Result: result}, nil)
	}
	queueRequests := make(chan request)
	requests.Add(1)
	go func() {
		defer requests.Done()
		for req := range queueRequests {
			handleRequest(req)
		}
	}()
	for {
		var prefix [8]byte
		if _, err := io.ReadFull(reader, prefix[:]); err != nil {
			break
		}
		headerLength := int(binary.BigEndian.Uint32(prefix[0:4]))
		bodyLength := int(binary.BigEndian.Uint32(prefix[4:8]))
		if headerLength < 1 || headerLength > maxFrameHeaderBytes || bodyLength < 0 || bodyLength > maxFrameBodyBytes {
			writeResponse(response{OK: false, Error: "invalid_frame"}, nil)
			break
		}
		header := make([]byte, headerLength)
		if _, err := io.ReadFull(reader, header); err != nil {
			break
		}
		var req request
		if bodyLength > 0 {
			req.Body = make([]byte, bodyLength)
			if _, err := io.ReadFull(reader, req.Body); err != nil {
				break
			}
		}
		if err := json.Unmarshal(header, &req); err != nil {
			writeResponse(response{OK: false, Error: "invalid_request"}, nil)
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

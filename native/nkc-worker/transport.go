package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptrace"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

const (
	transportRequestBodyLimit  = 3 * 1024 * 1024
	transportResponseBodyLimit = 2 * 1024 * 1024
	transportMaxInflight       = 8
	transportConnectTimeout    = 45 * time.Second
	transportIdleTimeout       = 65 * time.Second
	transportMaxRetryAttempts  = 3
)

type transportRetryParams struct {
	Attempts int `json:"attempts"`
	DelayMS  int `json:"delayMs"`
}

type transportFetchParams struct {
	context    context.Context
	URL        string            `json:"url"`
	Method     string            `json:"method"`
	Headers    map[string]string `json:"headers"`
	BodyBase64 string            `json:"bodyBase64"`
	// Internal forwarding already has JSON bytes; do not encode and decode them.
	Body          []byte               `json:"-"`
	TimeoutMS     int                  `json:"timeoutMs"`
	SocksProxyURL string               `json:"socksProxyUrl"`
	Retry         transportRetryParams `json:"retry"`
	Diagnose      bool                 `json:"diagnose,omitempty"`
}

type probeStageContextKey struct{}

func observeProbeStage(ctx context.Context, stage string) {
	if observe, ok := ctx.Value(probeStageContextKey{}).(func(string)); ok {
		observe(stage)
	}
}

type transportFetchResult struct {
	Status           int               `json:"status"`
	Headers          map[string]string `json:"headers"`
	BodyBase64       string            `json:"bodyBase64"`
	Attempts         int               `json:"attempts"`
	StageDurationsMS map[string]int64  `json:"stageDurationsMs,omitempty"`
	ConnectionCounts map[string]int    `json:"connectionCounts,omitempty"`
}

type transportEngine struct {
	mu            sync.Mutex
	clients       map[string]*http.Client
	transports    map[string]*http.Transport
	slots         chan struct{}
	fetchOverride func(transportFetchParams) (transportFetchResult, error)
}

func newTransportEngine() *transportEngine {
	return &transportEngine{
		clients:    make(map[string]*http.Client),
		transports: make(map[string]*http.Transport),
		slots:      make(chan struct{}, transportMaxInflight),
	}
}

func (e *transportEngine) clientFor(proxyURL string) *http.Client {
	e.mu.Lock()
	defer e.mu.Unlock()
	if client := e.clients[proxyURL]; client != nil {
		return client
	}
	transport := &http.Transport{
		MaxIdleConns:        transportMaxInflight,
		MaxIdleConnsPerHost: transportMaxInflight,
		IdleConnTimeout:     transportIdleTimeout,
		TLSHandshakeTimeout: transportConnectTimeout,
		DisableCompression:  true,
	}
	isolation := &onionIsolation{}
	transport.DialContext = func(ctx context.Context, _, address string) (net.Conn, error) {
		host, portText, err := net.SplitHostPort(address)
		if err != nil {
			return nil, err
		}
		port, err := strconv.Atoi(portText)
		if err != nil || port < 1 || port > 65535 {
			return nil, fmt.Errorf("invalid_target_port")
		}
		return dialSOCKSContext(ctx, isolation.proxyFor(proxyURL, host), host, port, transportConnectTimeout)
	}
	client := &http.Client{
		Transport: isolationRoundTripper{transport, isolation},
		CheckRedirect: func(_ *http.Request, _ []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}
	e.clients[proxyURL] = client
	e.transports[proxyURL] = transport
	return client
}

func (e *transportEngine) clearProxy(proxyURL string) {
	e.mu.Lock()
	defer e.mu.Unlock()
	if proxyURL == "" {
		for _, transport := range e.transports {
			transport.CloseIdleConnections()
		}
		e.clients = make(map[string]*http.Client)
		e.transports = make(map[string]*http.Transport)
		return
	}
	if transport := e.transports[proxyURL]; transport != nil {
		transport.CloseIdleConnections()
	}
	delete(e.clients, proxyURL)
	delete(e.transports, proxyURL)
}

func validateTransportParams(params transportFetchParams) ([]byte, error) {
	target, err := url.Parse(params.URL)
	if err != nil || target.Hostname() == "" || (target.Scheme != "http" && target.Scheme != "https") {
		return nil, fmt.Errorf("invalid_target_url")
	}
	if target.User != nil {
		return nil, fmt.Errorf("target_credentials_forbidden")
	}
	if _, err := parseProxy(params.SocksProxyURL); err != nil {
		return nil, err
	}
	method := strings.ToUpper(strings.TrimSpace(params.Method))
	if method == "" {
		method = http.MethodGet
	}
	switch method {
	case http.MethodGet, http.MethodHead, http.MethodPost, http.MethodPut, http.MethodPatch, http.MethodDelete:
	default:
		return nil, fmt.Errorf("unsupported_http_method")
	}
	if params.Body != nil {
		if len(params.Body) > transportRequestBodyLimit {
			return nil, fmt.Errorf("request_body_too_large")
		}
		return params.Body, nil
	}
	if len(params.BodyBase64) > base64.StdEncoding.EncodedLen(transportRequestBodyLimit) {
		return nil, fmt.Errorf("request_body_too_large")
	}
	if params.BodyBase64 == "" {
		return nil, nil
	}
	body, err := base64.StdEncoding.DecodeString(params.BodyBase64)
	if err != nil {
		return nil, fmt.Errorf("invalid_request_body")
	}
	if len(body) > transportRequestBodyLimit {
		return nil, fmt.Errorf("request_body_too_large")
	}
	return body, nil
}

func normalizeTransportError(err error) error {
	if err == nil {
		return nil
	}
	text := strings.ToLower(err.Error())
	if err == context.DeadlineExceeded || strings.Contains(text, "timeout") || strings.Contains(text, "deadline exceeded") {
		switch {
		case strings.Contains(text, "proxy_connect"):
			return fmt.Errorf("proxy_connect_timeout")
		case strings.Contains(text, "socks_handshake"), strings.Contains(text, "socks_auth"), strings.Contains(text, "socks_connect"):
			return fmt.Errorf("socks_handshake_timeout")
		default:
			return fmt.Errorf("upstream_response_timeout")
		}
	}
	for _, code := range []string{
		"socks_reply_general_failure",
		"socks_reply_ruleset_denied",
		"socks_reply_network_unreachable",
		"socks_reply_host_unreachable",
		"socks_reply_connection_refused",
		"socks_reply_ttl_expired",
		"socks_reply_command_unsupported",
		"socks_reply_address_unsupported",
		"socks_reply_unknown",
	} {
		if strings.Contains(text, code) {
			return fmt.Errorf("%s", code)
		}
	}
	if strings.Contains(text, "proxy_connect") {
		return fmt.Errorf("proxy_unreachable")
	}
	if strings.Contains(text, "socks_auth") || strings.Contains(text, "socks_handshake") || strings.Contains(text, "socks_connect") {
		return fmt.Errorf("socks_handshake_failed")
	}
	return err
}

func (e *transportEngine) fetch(params transportFetchParams) (result transportFetchResult, resultErr error) {
	if e.fetchOverride != nil {
		return e.fetchOverride(params)
	}
	body, err := validateTransportParams(params)
	if err != nil {
		return transportFetchResult{}, err
	}
	timeout := time.Duration(params.TimeoutMS) * time.Millisecond
	if timeout <= 0 {
		timeout = transportConnectTimeout
	}
	attempts := params.Retry.Attempts
	if attempts <= 0 {
		attempts = 1
	}
	if attempts > transportMaxRetryAttempts {
		attempts = transportMaxRetryAttempts
	}
	delay := time.Duration(params.Retry.DelayMS) * time.Millisecond
	if delay < 0 {
		delay = 0
	}

	// Bound admission and retries by the same IPC-visible request budget.
	parent := params.context
	if parent == nil {
		parent = context.Background()
	}
	budget, cancelBudget := context.WithTimeout(parent, timeout*time.Duration(attempts))
	defer cancelBudget()
	var stage atomic.Value
	stage.Store("admission")
	var stageMu sync.Mutex
	stageStarted := time.Now()
	var durations map[string]time.Duration
	newConnections, reusedConnections := 0, 0
	finished := false
	setStage := func(value string) {
		if !params.Diagnose {
			return
		}
		stageMu.Lock()
		defer stageMu.Unlock()
		if finished {
			return
		}
		now := time.Now()
		durations[stage.Load().(string)] += now.Sub(stageStarted)
		stageStarted = now
		stage.Store(value)
	}
	if params.Diagnose {
		durations = make(map[string]time.Duration)
		defer func() {
			stageMu.Lock()
			defer stageMu.Unlock()
			durations[stage.Load().(string)] += time.Since(stageStarted)
			finished = true
			result.StageDurationsMS = make(map[string]int64, len(durations))
			for name, duration := range durations {
				result.StageDurationsMS[name] = duration.Milliseconds()
			}
			result.ConnectionCounts = map[string]int{"new": newConnections, "reused": reusedConnections}
		}()
	}
	diagnoseError := func(err error) error {
		err = normalizeTransportError(err)
		if params.Diagnose && err != nil {
			return fmt.Errorf("probe_stage_%s:%w", stage.Load().(string), err)
		}
		return err
	}
	select {
	case e.slots <- struct{}{}:
	case <-budget.Done():
		return transportFetchResult{}, diagnoseError(budget.Err())
	}
	defer func() { <-e.slots }()
	client := e.clientFor(params.SocksProxyURL)
	var lastErr error
	for attempt := 1; attempt <= attempts; attempt++ {
		ctx, cancel := context.WithTimeout(budget, timeout)
		if params.Diagnose {
			setStage("connection")
			ctx = context.WithValue(ctx, probeStageContextKey{}, setStage)
			ctx = httptrace.WithClientTrace(ctx, &httptrace.ClientTrace{
				GotConn: func(info httptrace.GotConnInfo) {
					setStage("http_request")
					stageMu.Lock()
					defer stageMu.Unlock()
					if !finished {
						if info.Reused {
							reusedConnections++
						} else {
							newConnections++
						}
					}
				},
				WroteHeaders: func() { setStage("http_request_body") },
				WroteRequest: func(info httptrace.WroteRequestInfo) {
					if info.Err == nil {
						setStage("http_response")
					}
				},
				GotFirstResponseByte: func() { setStage("http_response_headers") },
			})
		}
		request, requestErr := http.NewRequestWithContext(ctx, strings.ToUpper(strings.TrimSpace(params.Method)), params.URL, bytes.NewReader(body))
		if requestErr != nil {
			cancel()
			return transportFetchResult{}, requestErr
		}
		if request.Method == "" {
			request.Method = http.MethodGet
		}
		for key, value := range params.Headers {
			request.Header.Set(key, value)
		}
		response, requestErr := client.Do(request)
		if requestErr == nil {
			setStage("http_body")
			raw, readErr := io.ReadAll(io.LimitReader(response.Body, transportResponseBodyLimit+1))
			_ = response.Body.Close()
			cancel()
			if readErr == nil && len(raw) <= transportResponseBodyLimit {
				headers := make(map[string]string, len(response.Header))
				for key, values := range response.Header {
					headers[strings.ToLower(key)] = strings.Join(values, ", ")
				}
				return transportFetchResult{
					Status: response.StatusCode, Headers: headers,
					BodyBase64: base64.StdEncoding.EncodeToString(raw), Attempts: attempt,
				}, nil
			}
			if readErr != nil {
				requestErr = readErr
			} else {
				requestErr = fmt.Errorf("response_body_too_large")
			}
		} else {
			cancel()
		}
		lastErr = diagnoseError(requestErr)
		if attempt < attempts && delay > 0 {
			setStage("retry_wait")
			select {
			case <-time.After(delay):
			case <-budget.Done():
				return transportFetchResult{}, diagnoseError(budget.Err())
			}
		}
	}
	return transportFetchResult{}, lastErr
}

package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	transportBodyLimit        = 256 * 1024
	transportMaxInflight      = 8
	transportConnectTimeout   = 45 * time.Second
	transportIdleTimeout      = 65 * time.Second
	transportMaxRetryAttempts = 3
)

type transportRetryParams struct {
	Attempts int `json:"attempts"`
	DelayMS  int `json:"delayMs"`
}

type transportFetchParams struct {
	URL           string               `json:"url"`
	Method        string               `json:"method"`
	Headers       map[string]string    `json:"headers"`
	BodyBase64    string               `json:"bodyBase64"`
	TimeoutMS     int                  `json:"timeoutMs"`
	SocksProxyURL string               `json:"socksProxyUrl"`
	Retry         transportRetryParams `json:"retry"`
}

type transportFetchResult struct {
	Status     int               `json:"status"`
	Headers    map[string]string `json:"headers"`
	BodyBase64 string            `json:"bodyBase64"`
	Attempts   int               `json:"attempts"`
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
		MaxIdleConnsPerHost: 2,
		IdleConnTimeout:     transportIdleTimeout,
		TLSHandshakeTimeout: transportConnectTimeout,
		DisableCompression:  true,
	}
	transport.DialContext = func(ctx context.Context, _, address string) (net.Conn, error) {
		host, portText, err := net.SplitHostPort(address)
		if err != nil {
			return nil, err
		}
		port, err := strconv.Atoi(portText)
		if err != nil || port < 1 || port > 65535 {
			return nil, fmt.Errorf("invalid_target_port")
		}
		return dialSOCKSContext(ctx, proxyURL, host, port, transportConnectTimeout)
	}
	client := &http.Client{
		Transport: transport,
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
	if params.BodyBase64 == "" {
		return nil, nil
	}
	body, err := base64.StdEncoding.DecodeString(params.BodyBase64)
	if err != nil {
		return nil, fmt.Errorf("invalid_request_body")
	}
	if len(body) > transportBodyLimit {
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

func (e *transportEngine) fetch(params transportFetchParams) (transportFetchResult, error) {
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

	e.slots <- struct{}{}
	defer func() { <-e.slots }()
	client := e.clientFor(params.SocksProxyURL)
	var lastErr error
	for attempt := 1; attempt <= attempts; attempt++ {
		ctx, cancel := context.WithTimeout(context.Background(), timeout)
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
			raw, readErr := io.ReadAll(io.LimitReader(response.Body, transportBodyLimit+1))
			_ = response.Body.Close()
			cancel()
			if readErr == nil && len(raw) <= transportBodyLimit {
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
		lastErr = normalizeTransportError(requestErr)
		if attempt < attempts && delay > 0 {
			time.Sleep(delay)
		}
	}
	return transportFetchResult{}, lastErr
}

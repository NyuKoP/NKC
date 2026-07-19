package main

import (
	"bufio"
	"encoding/binary"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func startTestSOCKSProxy(t *testing.T, upstreamAddress string) (string, *atomic.Int32, func()) {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	connections := &atomic.Int32{}
	done := make(chan struct{})
	go func() {
		for {
			client, acceptErr := listener.Accept()
			if acceptErr != nil {
				return
			}
			connections.Add(1)
			go func() {
				defer client.Close()
				reader := bufio.NewReader(client)
				greeting := make([]byte, 3)
				if _, readErr := io.ReadFull(reader, greeting); readErr != nil {
					return
				}
				if _, writeErr := client.Write([]byte{5, 0}); writeErr != nil {
					return
				}
				head := make([]byte, 4)
				if _, readErr := io.ReadFull(reader, head); readErr != nil {
					return
				}
				addressLength := 0
				switch head[3] {
				case 1:
					addressLength = 4
				case 4:
					addressLength = 16
				case 3:
					length, readErr := reader.ReadByte()
					if readErr != nil {
						return
					}
					addressLength = int(length)
				default:
					return
				}
				addressAndPort := make([]byte, addressLength+2)
				if _, readErr := io.ReadFull(reader, addressAndPort); readErr != nil {
					return
				}
				_ = binary.BigEndian.Uint16(addressAndPort[addressLength:])
				upstream, dialErr := net.Dial("tcp", upstreamAddress)
				if dialErr != nil {
					return
				}
				defer upstream.Close()
				if _, writeErr := client.Write([]byte{5, 0, 0, 1, 0, 0, 0, 0, 0, 0}); writeErr != nil {
					return
				}
				go func() { _, _ = io.Copy(upstream, reader) }()
				_, _ = io.Copy(client, upstream)
			}()
		}
	}()
	closeProxy := func() {
		_ = listener.Close()
		select {
		case <-done:
		default:
			close(done)
		}
	}
	return "socks5h://" + listener.Addr().String(), connections, closeProxy
}

func TestTransportFetchReusesSOCKSTunnel(t *testing.T) {
	target := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		response.Header().Set("X-Test", "yes")
		_, _ = response.Write([]byte("OK:" + request.URL.Path))
	}))
	defer target.Close()
	proxyURL, connections, closeProxy := startTestSOCKSProxy(t, strings.TrimPrefix(target.URL, "http://"))
	defer closeProxy()

	engine := newTransportEngine()
	defer engine.clearProxy("")
	for _, path := range []string{"/one", "/two"} {
		result, err := engine.fetch(transportFetchParams{
			URL: "http://keepalive-test.onion" + path, Method: http.MethodGet,
			SocksProxyURL: proxyURL, TimeoutMS: 2_000,
		})
		if err != nil {
			t.Fatal(err)
		}
		if result.Status != http.StatusOK || result.Headers["x-test"] != "yes" {
			t.Fatalf("unexpected response: %#v", result)
		}
	}
	if got := connections.Load(); got != 1 {
		t.Fatalf("expected one reusable SOCKS tunnel, got %d", got)
	}
}

func TestTransportFetchRejectsInvalidProxy(t *testing.T) {
	engine := newTransportEngine()
	_, err := engine.fetch(transportFetchParams{
		URL: "http://example.onion/", Method: http.MethodGet,
		SocksProxyURL: "http://127.0.0.1:9050",
	})
	if err == nil || err.Error() != "unsupported_socks_protocol" {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestTransportFetchDoesNotFollowRedirects(t *testing.T) {
	target := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
		response.Header().Set("Location", "http://clearnet.example/")
		response.WriteHeader(http.StatusFound)
	}))
	defer target.Close()
	proxyURL, _, closeProxy := startTestSOCKSProxy(t, strings.TrimPrefix(target.URL, "http://"))
	defer closeProxy()

	engine := newTransportEngine()
	defer engine.clearProxy("")
	result, err := engine.fetch(transportFetchParams{
		URL: "http://redirect-test.onion/", Method: http.MethodGet,
		SocksProxyURL: proxyURL, TimeoutMS: 2_000,
	})
	if err != nil {
		t.Fatal(err)
	}
	if result.Status != http.StatusFound {
		t.Fatalf("expected redirect response without following it, got %d", result.Status)
	}
}

func TestTransportFetchNormalizesTimeout(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	go func() {
		connection, acceptErr := listener.Accept()
		if acceptErr == nil {
			defer connection.Close()
			time.Sleep(200 * time.Millisecond)
		}
	}()
	engine := newTransportEngine()
	_, err = engine.fetch(transportFetchParams{
		URL: "http://example.onion/", Method: http.MethodGet,
		SocksProxyURL: "socks5h://" + listener.Addr().String(), TimeoutMS: 30,
	})
	if err == nil || err.Error() != "timeout" {
		t.Fatalf("unexpected error: %v", err)
	}
}

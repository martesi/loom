//go:build server

package application

import (
	"bytes"
	"context"
	"io"
	"net/http"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"
)

func TestServerMiddlewareWrapsCompleteHandler(t *testing.T) {
	globalApplication = nil

	const port = 18084
	var (
		mu    sync.Mutex
		paths []string
	)
	middleware := func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			mu.Lock()
			paths = append(paths, r.URL.Path)
			mu.Unlock()
			next.ServeHTTP(w, r)
		})
	}

	app := New(Options{
		Name: "Middleware test",
		Server: ServerOptions{
			Host:       "127.0.0.1",
			Port:       port,
			Middleware: middleware,
		},
		Assets: AssetOptions{
			Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.WriteHeader(http.StatusOK)
				_, _ = io.WriteString(w, "ok")
			}),
		},
	})
	errCh := make(chan error, 1)
	go func() { errCh <- app.Run() }()

	baseURL := "http://127.0.0.1:18084"
	client := &http.Client{Timeout: time.Second}
	deadline := time.Now().Add(3 * time.Second)
	for {
		resp, err := client.Get(baseURL + "/health")
		if err == nil {
			_ = resp.Body.Close()
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("server did not start: %v", err)
		}
		select {
		case err := <-errCh:
			t.Fatalf("app.Run() returned before startup: %v", err)
		default:
		}
		time.Sleep(10 * time.Millisecond)
	}

	defer func() {
		app.Quit()
		select {
		case err := <-errCh:
			if err != nil {
				t.Errorf("app.Run() returned error: %v", err)
			}
		case <-time.After(3 * time.Second):
			t.Error("timeout waiting for app shutdown")
		}
	}()

	for _, path := range []string{"/", "/wails/custom.js"} {
		resp, err := client.Get(baseURL + path)
		if err != nil {
			t.Fatalf("GET %s: %v", path, err)
		}
		_ = resp.Body.Close()
	}

	runtimeRequest, err := http.NewRequest(
		http.MethodPost,
		baseURL+"/wails/runtime",
		bytes.NewBufferString("{}"),
	)
	if err != nil {
		t.Fatal(err)
	}
	resp, err := client.Do(runtimeRequest)
	if err != nil {
		t.Fatalf("POST /wails/runtime: %v", err)
	}
	_ = resp.Body.Close()

	wsCtx, cancel := context.WithTimeout(context.Background(), time.Second)
	conn, _, err := websocket.Dial(wsCtx, "ws://127.0.0.1:18084/wails/events", nil)
	cancel()
	if err != nil {
		t.Fatalf("WebSocket dial: %v", err)
	}
	_ = conn.Close(websocket.StatusNormalClosure, "test complete")

	mu.Lock()
	seen := make(map[string]bool, len(paths))
	for _, path := range paths {
		seen[path] = true
	}
	mu.Unlock()

	for _, path := range []string{"/health", "/", "/wails/custom.js", "/wails/runtime", "/wails/events"} {
		if !seen[path] {
			t.Errorf("outer middleware did not see %s; paths = %v", path, paths)
		}
	}
}

package main

import (
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gorilla/websocket"
)

func TestHealthzHandler(t *testing.T) {
	cfg := config{env: "test"}
	req := httptest.NewRequest(http.MethodGet, "/healthz", nil)
	rec := httptest.NewRecorder()

	healthzHandler(cfg).ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected status %d, got %d", http.StatusOK, rec.Code)
	}

	var payload healthResponse
	if err := json.NewDecoder(rec.Body).Decode(&payload); err != nil {
		t.Fatalf("decode response: %v", err)
	}

	if payload.Status != "ok" {
		t.Fatalf("expected ok status, got %q", payload.Status)
	}
	if payload.Service != serviceName {
		t.Fatalf("expected service %q, got %q", serviceName, payload.Service)
	}
	if payload.Env != "test" {
		t.Fatalf("expected env test, got %q", payload.Env)
	}
}

func TestCORSAllowsConfiguredOrigin(t *testing.T) {
	cfg := config{
		allowedOrigins: map[string]struct{}{
			"http://localhost:5173": {},
		},
	}

	handler := withCORS(cfg, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))

	req := httptest.NewRequest(http.MethodOptions, "/healthz", nil)
	req.Header.Set("Origin", "http://localhost:5173")
	rec := httptest.NewRecorder()

	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusNoContent {
		t.Fatalf("expected preflight status %d, got %d", http.StatusNoContent, rec.Code)
	}
	if got := rec.Header().Get("Access-Control-Allow-Origin"); got != "http://localhost:5173" {
		t.Fatalf("expected configured origin header, got %q", got)
	}
}

func TestLoadConfigAllows5174ByDefault(t *testing.T) {
	t.Setenv("VOXMEM_ALLOWED_ORIGINS", "")

	cfg := loadConfig()
	if _, ok := cfg.allowedOrigins["http://127.0.0.1:5174"]; !ok {
		t.Fatal("expected default origins to include http://127.0.0.1:5174")
	}
}

func TestMockASRWebSocketFlow(t *testing.T) {
	cfg := config{
		allowedOrigins: map[string]struct{}{},
		asrMode:        "mock",
		asrMockText:    "mock final text",
	}

	server := httptest.NewServer(asrWebSocketHandler(cfg, testLogger()))
	defer server.Close()

	wsURL := "ws" + server.URL[len("http"):] + "?user_id=test"
	conn, _, err := websocket.DefaultDialer.Dial(wsURL, nil)
	if err != nil {
		t.Fatalf("dial mock asr websocket: %v", err)
	}
	defer conn.Close()

	var ready clientEvent
	if err := conn.ReadJSON(&ready); err != nil {
		t.Fatalf("read ready event: %v", err)
	}
	if ready.Type != "ready" || ready.TaskID == "" {
		t.Fatalf("unexpected ready event: %+v", ready)
	}

	if err := conn.WriteMessage(websocket.BinaryMessage, []byte{0, 1, 2, 3}); err != nil {
		t.Fatalf("write audio frame: %v", err)
	}
	var partial clientEvent
	if err := conn.ReadJSON(&partial); err != nil {
		t.Fatalf("read partial transcript: %v", err)
	}
	if partial.Type != "transcript" || partial.Final {
		t.Fatalf("unexpected partial transcript: %+v", partial)
	}

	if err := conn.WriteJSON(clientEvent{Type: "stop"}); err != nil {
		t.Fatalf("write stop event: %v", err)
	}

	var final clientEvent
	if err := conn.ReadJSON(&final); err != nil {
		t.Fatalf("read final transcript: %v", err)
	}
	if final.Type != "transcript" || !final.Final || final.Text != "mock final text" {
		t.Fatalf("unexpected final transcript: %+v", final)
	}

	var done clientEvent
	if err := conn.ReadJSON(&done); err != nil {
		t.Fatalf("read done event: %v", err)
	}
	if done.Type != "done" || done.TaskID != ready.TaskID {
		t.Fatalf("unexpected done event: %+v", done)
	}
}

func testLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}

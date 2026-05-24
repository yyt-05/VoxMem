package main

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gorilla/websocket"
	"github.com/yyt-05/VoxMem/server/internal/memory"
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
	store := testStore(t)
	defer store.Close()

	cfg := config{
		allowedOrigins: map[string]struct{}{},
		asrMode:        "mock",
		asrMockText:    "mock final text",
	}

	server := httptest.NewServer(asrWebSocketHandler(cfg, testLogger(), store))
	defer server.Close()

	wsURL := "ws" + server.URL[len("http"):] + "?user_id=test&mode=raw"
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

	var inputReady clientEvent
	if err := conn.ReadJSON(&inputReady); err != nil {
		t.Fatalf("read input ready event: %v", err)
	}
	if inputReady.Type != "input_ready" || inputReady.Text != "mock final text" || inputReady.Mode != "raw" {
		t.Fatalf("unexpected input ready event: %+v", inputReady)
	}

	var done clientEvent
	if err := conn.ReadJSON(&done); err != nil {
		t.Fatalf("read done event: %v", err)
	}
	if done.Type != "done" || done.TaskID != ready.TaskID {
		t.Fatalf("unexpected done event: %+v", done)
	}
}

func TestMockASRPolishReturnsEditableInputWithoutLLM(t *testing.T) {
	store := testStore(t)
	defer store.Close()

	cfg := config{
		allowedOrigins: map[string]struct{}{},
		asrMode:        "mock",
		asrMockText:    "今天是星期一，不对今天是星期二",
	}

	server := httptest.NewServer(asrWebSocketHandler(cfg, testLogger(), store))
	defer server.Close()

	wsURL := "ws" + server.URL[len("http"):] + "?user_id=test&mode=polish"
	conn, _, err := websocket.DefaultDialer.Dial(wsURL, nil)
	if err != nil {
		t.Fatalf("dial mock asr websocket: %v", err)
	}
	defer conn.Close()

	var ready clientEvent
	if err := conn.ReadJSON(&ready); err != nil {
		t.Fatalf("read ready event: %v", err)
	}
	if err := conn.WriteJSON(clientEvent{Type: "stop"}); err != nil {
		t.Fatalf("write stop event: %v", err)
	}

	var partial clientEvent
	if err := conn.ReadJSON(&partial); err != nil {
		t.Fatalf("read partial transcript: %v", err)
	}
	var final clientEvent
	if err := conn.ReadJSON(&final); err != nil {
		t.Fatalf("read final transcript: %v", err)
	}
	var inputReady clientEvent
	if err := conn.ReadJSON(&inputReady); err != nil {
		t.Fatalf("read input ready event: %v", err)
	}
	if inputReady.Type != "input_ready" || inputReady.Text == "" {
		t.Fatalf("unexpected input ready event: %+v", inputReady)
	}
}

func TestInputCommitHandlerProcessesRawAndSavesCorrection(t *testing.T) {
	store := testStore(t)
	defer store.Close()

	body := strings.NewReader(`{
		"user_id": "user-1",
		"session_id": "session-1",
		"mode": "raw",
		"original_text": "今天找张力确认方案",
		"enhanced_text": "今天找张力确认方案",
		"final_text": "今天找张立确认方案"
	}`)
	req := httptest.NewRequest(http.MethodPost, "/api/input/commit", body)
	rec := httptest.NewRecorder()

	inputCommitHandler(config{}, store, testLogger()).ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected input commit status %d, got %d: %s", http.StatusOK, rec.Code, rec.Body.String())
	}

	var payload inputCommitResponse
	if err := json.NewDecoder(rec.Body).Decode(&payload); err != nil {
		t.Fatalf("decode input commit response: %v", err)
	}
	if payload.Text != "今天找张立确认方案" || payload.Source != "local" {
		t.Fatalf("unexpected input commit response: %+v", payload)
	}
	if len(payload.Mappings) != 1 || payload.Mappings[0].FromText != "张力" || payload.Mappings[0].ToText != "张立" {
		t.Fatalf("unexpected learned mappings: %+v", payload.Mappings)
	}
}

func TestInputCommitHandlerDoesNotDuplicateSameCorrection(t *testing.T) {
	store := testStore(t)
	defer store.Close()

	body := `{
		"user_id": "user-1",
		"session_id": "session-1",
		"mode": "raw",
		"original_text": "今天找张力确认方案",
		"enhanced_text": "今天找张力确认方案",
		"final_text": "今天找张立确认方案"
	}`

	for i := 0; i < 2; i++ {
		req := httptest.NewRequest(http.MethodPost, "/api/input/commit", strings.NewReader(body))
		rec := httptest.NewRecorder()
		inputCommitHandler(config{}, store, testLogger()).ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("expected input commit status %d, got %d: %s", http.StatusOK, rec.Code, rec.Body.String())
		}
	}

	mappings, err := store.ListMappings(context.Background(), "user-1")
	if err != nil {
		t.Fatalf("list mappings: %v", err)
	}
	if len(mappings) != 1 || mappings[0].CorrectionCount != 1 {
		t.Fatalf("expected one mapping with one correction, got %+v", mappings)
	}
}

func TestCorrectionAndHotwordsHandlers(t *testing.T) {
	store := testStore(t)
	defer store.Close()

	body := strings.NewReader(`{
		"user_id": "user-1",
		"session_id": "session-1",
		"original_text": "今天找张力确认方案",
		"corrected_text": "今天找张立确认方案"
	}`)
	req := httptest.NewRequest(http.MethodPost, "/api/correction", body)
	rec := httptest.NewRecorder()

	correctionHandler(store, testLogger()).ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected correction status %d, got %d: %s", http.StatusOK, rec.Code, rec.Body.String())
	}

	req = httptest.NewRequest(http.MethodGet, "/api/hotwords?user_id=user-1", nil)
	rec = httptest.NewRecorder()
	hotwordsHandler(store, testLogger()).ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected hotwords status %d, got %d", http.StatusOK, rec.Code)
	}
	if !strings.Contains(rec.Body.String(), "张力") || !strings.Contains(rec.Body.String(), "张立") {
		t.Fatalf("expected mapping in hotwords response, got %s", rec.Body.String())
	}
}

func testLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}

func testStore(t *testing.T) *memory.Store {
	t.Helper()
	store, err := memory.Open(":memory:")
	if err != nil {
		t.Fatalf("open test store: %v", err)
	}
	return store
}

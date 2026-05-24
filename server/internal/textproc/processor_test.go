package textproc

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestProcessRequiresLLMConfigForPolish(t *testing.T) {
	_, err := Process(context.Background(), Config{}, ModePolish, "今天是星期一，不对今天是星期二")
	if err == nil {
		t.Fatal("expected missing LLM config error")
	}
}

func TestProcessRawModeSkipsLLM(t *testing.T) {
	result, err := Process(context.Background(), Config{}, ModeRaw, "今天是星期一，不对今天是星期二")
	if err != nil {
		t.Fatalf("raw mode returned error: %v", err)
	}
	if result.Text != "今天是星期一，不对今天是星期二" {
		t.Fatalf("raw mode changed text: %q", result.Text)
	}
	if result.Status != "skipped" || result.Source != "local" {
		t.Fatalf("unexpected raw result metadata: %+v", result)
	}
}

func TestParseModeRejectsUnsupportedMode(t *testing.T) {
	if _, err := ParseMode("email"); err == nil {
		t.Fatal("expected unsupported mode error")
	}
}

func TestProcessUsesOpenAICompatibleChatCompletion(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/chat/completions" {
			t.Fatalf("unexpected path: %s", r.URL.Path)
		}
		if got := r.Header.Get("Authorization"); got != "Bearer test-key" {
			t.Fatalf("unexpected authorization header: %q", got)
		}
		var request chatRequest
		if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
			t.Fatalf("decode request: %v", err)
		}
		if request.Model != "test-model" {
			t.Fatalf("unexpected model: %q", request.Model)
		}
		writeTestJSON(w, chatResponse{
			Choices: []struct {
				Message chatMessage `json:"message"`
			}{
				{Message: chatMessage{Role: "assistant", Content: "今天是星期二"}},
			},
		})
	}))
	defer server.Close()

	result, err := Process(context.Background(), Config{
		APIKey:  "test-key",
		BaseURL: server.URL,
		Model:   "test-model",
	}, ModePolish, "今天是星期一，不对今天是星期二")
	if err != nil {
		t.Fatalf("process with llm: %v", err)
	}
	if result.Text != "今天是星期二" {
		t.Fatalf("unexpected processed text: %q", result.Text)
	}
	if result.Source != "llm" || result.Status != "completed" {
		t.Fatalf("unexpected result metadata: %+v", result)
	}
}

func writeTestJSON(w http.ResponseWriter, payload any) {
	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(payload); err != nil {
		panic(err)
	}
}

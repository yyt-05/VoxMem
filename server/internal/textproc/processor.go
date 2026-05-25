package textproc

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"regexp"
	"strings"
	"time"
)

type Mode string

const (
	ModeRaw      Mode = "raw"
	ModePolish   Mode = "polish"
	ModeMarkdown Mode = "markdown"
)

type Config struct {
	APIKey  string
	BaseURL string
	Model   string
	Timeout time.Duration
}

type Result struct {
	Text      string `json:"text"`
	Mode      Mode   `json:"mode"`
	Status    string `json:"status"`
	Source    string `json:"source"`
	LatencyMS int64  `json:"latency_ms"`
}

type chatRequest struct {
	Model       string        `json:"model"`
	Messages    []chatMessage `json:"messages"`
	Temperature float64       `json:"temperature"`
}

type chatMessage struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

type chatResponse struct {
	Choices []struct {
		Message chatMessage `json:"message"`
	} `json:"choices"`
	Error *struct {
		Message string `json:"message"`
		Type    string `json:"type"`
	} `json:"error,omitempty"`
}

func Process(ctx context.Context, cfg Config, mode Mode, input string, formatHint string) (Result, error) {
	startedAt := time.Now()
	input = strings.TrimSpace(input)
	if err := ValidateMode(mode); err != nil {
		return Result{Mode: mode, Status: "failed", Source: "none", LatencyMS: 0}, err
	}

	if input == "" {
		return Result{Text: "", Mode: mode, Status: "skipped", Source: "none", LatencyMS: 0}, nil
	}
	if mode == ModeRaw {
		return Result{Text: input, Mode: mode, Status: "skipped", Source: "local", LatencyMS: time.Since(startedAt).Milliseconds()}, nil
	}

	llmInput := input
	if mode == ModePolish {
		llmInput = localPolish(input)
	}

	output, err := processWithLLM(ctx, cfg, mode, llmInput, formatHint)
	if err != nil {
		if mode == ModePolish {
			output = localPolish(input)
			return Result{
				Text:      output,
				Mode:      mode,
				Status:    "completed",
				Source:    "local_fallback",
				LatencyMS: time.Since(startedAt).Milliseconds(),
			}, nil
		}
		return Result{Mode: mode, Status: "failed", Source: "llm", LatencyMS: time.Since(startedAt).Milliseconds()}, err
	}
	return Result{
		Text:      output,
		Mode:      mode,
		Status:    "completed",
		Source:    "llm",
		LatencyMS: time.Since(startedAt).Milliseconds(),
	}, nil
}

func ParseMode(value string) (Mode, error) {
	value = strings.TrimSpace(value)
	if value == "" {
		return ModePolish, nil
	}
	mode := Mode(value)
	if err := ValidateMode(mode); err != nil {
		return "", err
	}
	return mode, nil
}

func ValidateMode(mode Mode) error {
	switch mode {
	case ModeRaw, ModePolish, ModeMarkdown:
		return nil
	default:
		return fmt.Errorf("unsupported output mode %q", mode)
	}
}

func processWithLLM(ctx context.Context, cfg Config, mode Mode, input string, formatHint string) (string, error) {
	apiKey := strings.TrimSpace(cfg.APIKey)
	if apiKey == "" {
		return "", errors.New("VOXMEM_LLM_API_KEY is not configured")
	}
	baseURL := strings.TrimRight(strings.TrimSpace(cfg.BaseURL), "/")
	if baseURL == "" {
		return "", errors.New("VOXMEM_LLM_BASE_URL is not configured")
	}
	model := strings.TrimSpace(cfg.Model)
	if model == "" {
		return "", errors.New("VOXMEM_LLM_MODEL is not configured")
	}
	timeout := cfg.Timeout
	if timeout <= 0 {
		timeout = 8 * time.Second
	}

	requestPayload := chatRequest{
		Model:       model,
		Temperature: 0.1,
		Messages: []chatMessage{
			{Role: "system", Content: systemPrompt(mode, formatHint)},
			{Role: "user", Content: input},
		},
	}
	body, err := json.Marshal(requestPayload)
	if err != nil {
		return "", fmt.Errorf("marshal llm request: %w", err)
	}

	reqCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	req, err := http.NewRequestWithContext(reqCtx, http.MethodPost, baseURL+"/chat/completions", bytes.NewReader(body))
	if err != nil {
		return "", fmt.Errorf("create llm request: %w", err)
	}
	req.Header.Set("Authorization", "Bearer "+apiKey)
	req.Header.Set("Content-Type", "application/json")

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return "", fmt.Errorf("call llm: %w", err)
	}
	defer resp.Body.Close()

	var payload chatResponse
	if err := json.NewDecoder(resp.Body).Decode(&payload); err != nil {
		return "", fmt.Errorf("decode llm response: %w", err)
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		if payload.Error != nil && payload.Error.Message != "" {
			return "", fmt.Errorf("llm request failed: %s", payload.Error.Message)
		}
		return "", fmt.Errorf("llm request failed with HTTP %d", resp.StatusCode)
	}
	if len(payload.Choices) == 0 {
		return "", errors.New("llm response has no choices")
	}

	output := strings.TrimSpace(payload.Choices[0].Message.Content)
	if output == "" {
		return "", errors.New("llm response is empty")
	}
	return output, nil
}

var (
	fillerSoundRe    = regexp.MustCompile(`[嗯呃]+嘛?[，,、\s]*`)
	repeatedFillerRe = regexp.MustCompile(`(那个[，,、\s]*){2,}`)
	contextFillerRe  = regexp.MustCompile(`(^|[，,。！？；;:\s])那个(叫|你|我|他|她|它|这|那|要|去|帮|把|给|联系|确认|处理|做|看|说|问)`)
	spaceRe          = regexp.MustCompile(`\s+`)
)

func localPolish(input string) string {
	output := strings.TrimSpace(input)
	if output == "" {
		return ""
	}
	output = applySimpleSelfCorrection(output)
	output = strings.ReplaceAll(output, "然后那个", "然后")
	output = strings.ReplaceAll(output, "我说", "")
	output = strings.ReplaceAll(output, "什么东西", "")
	output = repeatedFillerRe.ReplaceAllString(output, "")
	output = contextFillerRe.ReplaceAllString(output, "$1$2")
	output = fillerSoundRe.ReplaceAllString(output, "")
	output = spaceRe.ReplaceAllString(output, " ")
	output = strings.TrimSpace(output)
	output = strings.TrimLeft(output, "，,。、；;：:！？!? ")
	output = strings.ReplaceAll(output, "，，", "，")
	output = strings.ReplaceAll(output, "，。", "。")
	if output == "" {
		return strings.TrimSpace(input)
	}
	return output
}

func applySimpleSelfCorrection(input string) string {
	for _, marker := range []string{"不对，", "不对,", "不对"} {
		if before, after, ok := strings.Cut(input, marker); ok && strings.TrimSpace(before) != "" && strings.TrimSpace(after) != "" {
			return strings.TrimSpace(after)
		}
	}
	return input
}

func systemPrompt(mode Mode, formatHint string) string {
	base := ""
	if mode == ModeMarkdown {
		base = "你是 VoxMem 的中文语音输入整理器。\n只输出 Markdown 正文，不要解释。\n保留用户原意，不添加原文没有的信息。\n把口语化转写改成自然、可读的书面中文。\n识别“第一点、第二点、首先、然后、最后”等口头列表表达，整理为 Markdown 列表。\n遇到“不对、不是、应该是、改成”等明确自我纠正时，以纠正后的内容为准。\n删除“呃、嗯、嗯嘛、那个、然后那个、我说、什么东西”等无意义口头填充和重复片段。"
	} else {
		base = "你是 VoxMem 的中文语音输入整理器。\n只输出整理后的正文，不要解释。\n保留用户原意，不添加原文没有的信息。\n把口语化转写改成自然、可读的书面中文。\n处理“不对、不是、应该是、改成”等明确自我纠正表达，以纠正后的内容为准。\n如果用户说“下周一不对，下周三之前...”，意思是删除被否定的“下周一”，保留“下周三之前...”，不要改写成“下周一不行”。\n删除“呃、嗯、嗯嘛、那个、然后那个、我说、什么东西”等无意义口头填充和重复片段。\n可以补齐必要标点和断句，让文本更清晰，但不要主观扩写。"
	}
	if formatHint != "" {
		base += "\n\n" + formatHint
	}
	return strings.TrimSpace(base)
}

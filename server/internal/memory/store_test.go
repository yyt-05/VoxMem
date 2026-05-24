package memory

import (
	"context"
	"testing"
)

func TestExtractMappingsExpandsShortNameChange(t *testing.T) {
	mappings := ExtractMappings("今天找张力确认方案", "今天找张立确认方案")

	if len(mappings) != 1 {
		t.Fatalf("expected one mapping, got %d", len(mappings))
	}
	if mappings[0].FromText != "张力" || mappings[0].ToText != "张立" {
		t.Fatalf("unexpected mapping: %+v", mappings[0])
	}
}

func TestStoreSaveAndApplyMappings(t *testing.T) {
	store, err := Open(":memory:")
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	defer store.Close()

	ctx := context.Background()
	saved, err := store.SaveCorrection(ctx, Correction{
		UserID:        "user-1",
		SessionID:     "session-1",
		OriginalText:  "今天找张力确认方案",
		CorrectedText: "今天找张立确认方案",
	})
	if err != nil {
		t.Fatalf("save correction: %v", err)
	}
	if len(saved) != 1 {
		t.Fatalf("expected one saved mapping, got %d", len(saved))
	}

	output, hits, err := store.ApplyMappings(ctx, "user-1", "明天继续找张力补测试")
	if err != nil {
		t.Fatalf("apply mappings: %v", err)
	}
	if output != "明天继续找张立补测试" {
		t.Fatalf("unexpected output: %q", output)
	}
	if len(hits) != 1 || hits[0].FromText != "张力" {
		t.Fatalf("unexpected hits: %+v", hits)
	}
}

func TestStoreSaveCorrectionUsesEnhancedTextAsMappingBase(t *testing.T) {
	store, err := Open(":memory:")
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	defer store.Close()

	ctx := context.Background()
	saved, err := store.SaveCorrection(ctx, Correction{
		UserID:        "user-1",
		SessionID:     "session-1",
		OriginalText:  "今天找张力和王力确认方案",
		EnhancedText:  "今天找张立和王力确认方案",
		CorrectedText: "今天找张立和王立确认方案",
	})
	if err != nil {
		t.Fatalf("save correction: %v", err)
	}
	if len(saved) != 1 || saved[0].FromText != "王力" || saved[0].ToText != "王立" {
		t.Fatalf("expected enhanced-text diff to learn 王力 -> 王立, got %+v", saved)
	}
}

func TestStoreSaveCorrectionDeduplicatesExactCorrection(t *testing.T) {
	store, err := Open(":memory:")
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	defer store.Close()

	ctx := context.Background()
	correction := Correction{
		UserID:        "user-1",
		SessionID:     "session-1",
		OriginalText:  "今天找张力确认方案",
		CorrectedText: "今天找张立确认方案",
	}
	if _, err := store.SaveCorrection(ctx, correction); err != nil {
		t.Fatalf("save correction: %v", err)
	}
	if _, err := store.SaveCorrection(ctx, correction); err != nil {
		t.Fatalf("save duplicate correction: %v", err)
	}

	mappings, err := store.ListMappings(ctx, "user-1")
	if err != nil {
		t.Fatalf("list mappings: %v", err)
	}
	if len(mappings) != 1 || mappings[0].CorrectionCount != 1 {
		t.Fatalf("expected duplicate correction to be ignored, got %+v", mappings)
	}
}

func TestDeleteMapping(t *testing.T) {
	store, err := Open(":memory:")
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	defer store.Close()

	ctx := context.Background()
	saved, err := store.SaveCorrection(ctx, Correction{
		UserID:        "user-1",
		OriginalText:  "今天找张力确认方案",
		CorrectedText: "今天找张立确认方案",
	})
	if err != nil {
		t.Fatalf("save correction: %v", err)
	}

	if err := store.DeleteMapping(ctx, "user-1", saved[0].ID); err != nil {
		t.Fatalf("delete mapping: %v", err)
	}

	output, _, err := store.ApplyMappings(ctx, "user-1", "今天找张力确认方案")
	if err != nil {
		t.Fatalf("apply mappings after delete: %v", err)
	}
	if output != "今天找张力确认方案" {
		t.Fatalf("expected mapping to be deleted, got %q", output)
	}
}

func TestStoreSaveCorrectionReplacesConflictingMapping(t *testing.T) {
	store, err := Open(":memory:")
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	defer store.Close()

	ctx := context.Background()
	if _, err := store.SaveCorrection(ctx, Correction{
		UserID:        "user-1",
		SessionID:     "session-1",
		OriginalText:  "今天找张力确认方案",
		CorrectedText: "今天找张立确认方案",
	}); err != nil {
		t.Fatalf("save first correction: %v", err)
	}
	if _, err := store.SaveCorrection(ctx, Correction{
		UserID:        "user-1",
		SessionID:     "session-2",
		OriginalText:  "今天找张力确认方案",
		CorrectedText: "今天找张莉确认方案",
	}); err != nil {
		t.Fatalf("save conflicting correction: %v", err)
	}

	mappings, err := store.ListMappings(ctx, "user-1")
	if err != nil {
		t.Fatalf("list mappings: %v", err)
	}
	if len(mappings) != 1 || mappings[0].FromText != "张力" || mappings[0].ToText != "张莉" {
		t.Fatalf("expected latest conflicting mapping to remain, got %+v", mappings)
	}
}

func TestExtractMappingsSkipsHighChangeRatio(t *testing.T) {
	mappings := ExtractMappings("今天要去找张三做对接", "今天确认一下方案")
	if len(mappings) != 0 {
		t.Fatalf("expected high change ratio to be skipped, got %+v", mappings)
	}
}

func TestExtractMappingsSkipsFunctionWords(t *testing.T) {
	mappings := ExtractMappings("今天要去找张力", "今天找张力")
	if len(mappings) != 0 {
		t.Fatalf("expected function-word change to be skipped, got %+v", mappings)
	}
}

func TestExtractMappingsSkipsVerbRewrite(t *testing.T) {
	mappings := ExtractMappings("今天找张三做对接", "今天找张三确认方案")
	if len(mappings) != 0 {
		t.Fatalf("expected verb rewrite to be skipped, got %+v", mappings)
	}
}

func TestExtractMappingsKeepsNameCorrection(t *testing.T) {
	mappings := ExtractMappings("今天找张立确认方案", "今天找张莉确认方案")
	if len(mappings) != 1 {
		t.Fatalf("expected one mapping, got %d", len(mappings))
	}
	if mappings[0].FromText != "张立" || mappings[0].ToText != "张莉" {
		t.Fatalf("unexpected mapping: %+v", mappings[0])
	}
}

func TestExtractMappingsKeepsTechnicalTermCorrection(t *testing.T) {
	mappings := ExtractMappings("确认熔断基制已生效", "确认熔断机制已生效")
	if len(mappings) != 1 {
		t.Fatalf("expected one mapping, got %d", len(mappings))
	}
	if mappings[0].FromText != "断基" || mappings[0].ToText != "断机" {
		t.Fatalf("unexpected mapping: %+v", mappings[0])
	}
}

func TestIsEntityLikeRejectsFunctionWords(t *testing.T) {
	tests := []struct {
		input    string
		expected bool
	}{
		{"张力", true},
		{"张三", true},
		{"熔断机制", true},
		{"要去找", false}, // 要/去 are function words
		{"做对接", false}, // 做 is function word
		{"的", false},   // too short + function word
		{"这个", false},  // 这/个
	}
	for _, test := range tests {
		got := isEntityLike(test.input)
		if got != test.expected {
			t.Errorf("isEntityLike(%q) = %v, expected %v", test.input, got, test.expected)
		}
	}
}

func TestChangeRatioTooHigh(t *testing.T) {
	tests := []struct {
		original  string
		corrected string
		expected  bool
	}{
		{"今天找张立确认方案", "今天找张莉确认方案", false}, // one char change
		{"今天要去找张三做对接", "今天确认一下方案", true},  // major rewrite
		{"张三", "确认一下方案", true},            // complete rewrite
		{"张力", "张立", false},               // one char
	}
	for _, test := range tests {
		got := changeRatioTooHigh(test.original, test.corrected)
		if got != test.expected {
			t.Errorf("changeRatioTooHigh(%q, %q) = %v, expected %v", test.original, test.corrected, got, test.expected)
		}
	}
}

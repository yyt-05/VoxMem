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

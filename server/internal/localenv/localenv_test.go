package localenv

import (
	"os"
	"path/filepath"
	"testing"
)

func TestLoadFilesLoadsSimpleDotEnv(t *testing.T) {
	t.Setenv("VOXMEM_TEST_ENV", "")
	if err := os.Unsetenv("VOXMEM_TEST_ENV"); err != nil {
		t.Fatalf("unset env: %v", err)
	}

	path := filepath.Join(t.TempDir(), ".env")
	if err := os.WriteFile(path, []byte("VOXMEM_TEST_ENV=\"hello\"\n"), 0o600); err != nil {
		t.Fatalf("write env file: %v", err)
	}

	if err := LoadFiles(path); err != nil {
		t.Fatalf("load env file: %v", err)
	}

	if got := os.Getenv("VOXMEM_TEST_ENV"); got != "hello" {
		t.Fatalf("expected env value hello, got %q", got)
	}
}

func TestLoadFilesDoesNotOverrideExistingEnv(t *testing.T) {
	t.Setenv("VOXMEM_TEST_EXISTING", "existing")

	path := filepath.Join(t.TempDir(), ".env")
	if err := os.WriteFile(path, []byte("VOXMEM_TEST_EXISTING=file\n"), 0o600); err != nil {
		t.Fatalf("write env file: %v", err)
	}

	if err := LoadFiles(path); err != nil {
		t.Fatalf("load env file: %v", err)
	}

	if got := os.Getenv("VOXMEM_TEST_EXISTING"); got != "existing" {
		t.Fatalf("expected existing env value, got %q", got)
	}
}

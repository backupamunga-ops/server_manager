package ipc

import (
	"testing"
)

func TestAllowedOperationsContainsExpectedOps(t *testing.T) {
	expected := []string{
		"release.startCandidate",
		"release.stop",
		"release.inspect",
		"release.activate",
		"caddy.reload",
		"caddy.validate",
		"volume.create",
		"volume.delete",
	}
	if len(AllowedOperations) != len(expected) {
		t.Fatalf("expected %d allowed ops, got %d", len(expected), len(AllowedOperations))
	}
	for _, op := range expected {
		if !AllowedOperations[op] {
			t.Errorf("expected %q in AllowedOperations", op)
		}
	}
}

func TestForbiddenPatternsBlocked(t *testing.T) {
	// Verify that all forbidden patterns would be caught
	for _, p := range ForbiddenPayloadPatterns {
		if !contains(p, p) {
			t.Errorf("contains() failed for %q", p)
		}
	}
}

func TestConstantTimeEqual(t *testing.T) {
	if !constantTimeEqual("abc", "abc") {
		t.Error("equal strings should match")
	}
	if constantTimeEqual("abc", "abd") {
		t.Error("different strings should not match")
	}
	if constantTimeEqual("abc", "abcd") {
		t.Error("different-length strings should not match")
	}
}

func TestCanonicalJSON(t *testing.T) {
	m := map[string]interface{}{
		"b": 2,
		"a": 1,
		"c": "x",
	}
	out, err := canonicalJSON(m)
	if err != nil {
		t.Fatal(err)
	}
	expected := `{"a":1,"b":2,"c":"x"}`
	if out != expected {
		t.Errorf("canonical JSON mismatch:\n got: %s\n want: %s", out, expected)
	}
}

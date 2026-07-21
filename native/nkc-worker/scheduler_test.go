package main

import "testing"

func TestSchedulerPrioritizesChatAndComputesBackoff(t *testing.T) {
	result, err := planSchedule(scheduleParams{
		Now: 10_000, Mode: "tor", BatchSize: 2,
		Items: []scheduleItem{
			{ID: "file", Priority: "normal", Attempts: 1, NextAttemptAtMs: 9_000, ExpiresAtMs: 20_000, CreatedAtMs: 1},
			{ID: "chat", Priority: "high", Attempts: 0, NextAttemptAtMs: 9_500, ExpiresAtMs: 20_000, CreatedAtMs: 2},
			{ID: "expired", Priority: "high", Attempts: 0, NextAttemptAtMs: 1, ExpiresAtMs: 9_999, CreatedAtMs: 0},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	selected := result.(map[string]any)["selected"].([]map[string]any)
	if len(selected) != 2 || selected[0]["id"] != "chat" || selected[1]["id"] != "file" {
		t.Fatalf("unexpected order: %#v", selected)
	}
	if selected[0]["nextAttemptAtMs"].(int64) <= int64(10_000) {
		t.Fatalf("backoff was not computed")
	}
}

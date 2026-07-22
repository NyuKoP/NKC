package main

import (
	"hash/fnv"
	"math"
	"sort"
)

type scheduleItem struct {
	ID              string `json:"id"`
	Priority        string `json:"priority"`
	Attempts        int    `json:"attempts"`
	NextAttemptAtMs int64  `json:"nextAttemptAtMs"`
	ExpiresAtMs     int64  `json:"expiresAtMs"`
	CreatedAtMs     int64  `json:"createdAtMs"`
}

type scheduleParams struct {
	Now       int64          `json:"now"`
	Mode      string         `json:"mode"`
	BatchSize int            `json:"batchSize"`
	Items     []scheduleItem `json:"items"`
}

type retryPolicy struct {
	MaxAttempts int
	BaseDelayMs int64
	MaxDelayMs  int64
	JitterRatio float64
}

var retryPolicies = map[string]retryPolicy{
	"direct": {6, 700, 10_000, .15},
	"tor":    {12, 2_000, 90_000, .25},
	"onion":  {15, 3_000, 120_000, .30},
}

func deterministicUnit(id string, attempts int) float64 {
	hash := fnv.New64a()
	_, _ = hash.Write([]byte(id))
	_, _ = hash.Write([]byte{byte(attempts), byte(attempts >> 8)})
	return float64(hash.Sum64()%1_000_001) / 1_000_000
}

func nextAttempt(now int64, item scheduleItem, policy retryPolicy) int64 {
	exponent := math.Pow(2, float64(max(item.Attempts, 0)))
	capped := min(float64(policy.BaseDelayMs)*exponent, float64(policy.MaxDelayMs))
	jitter := capped * policy.JitterRatio
	delay := capped + (deterministicUnit(item.ID, item.Attempts)*2-1)*jitter
	delay = max(0, min(delay, float64(policy.MaxDelayMs)))
	return now + int64(math.Round(delay))
}

func planSchedule(params scheduleParams) (any, error) {
	policy, ok := retryPolicies[params.Mode]
	if !ok {
		policy = retryPolicies["onion"]
	}
	if params.BatchSize < 1 {
		params.BatchSize = 20
	}
	eligible := make([]scheduleItem, 0, len(params.Items))
	for _, item := range params.Items {
		if item.ID == "" || item.Attempts >= policy.MaxAttempts || item.ExpiresAtMs <= params.Now || item.NextAttemptAtMs > params.Now {
			continue
		}
		eligible = append(eligible, item)
	}
	sort.SliceStable(eligible, func(i, j int) bool {
		left, right := eligible[i], eligible[j]
		if left.Priority != right.Priority {
			return left.Priority == "high"
		}
		if left.NextAttemptAtMs != right.NextAttemptAtMs {
			return left.NextAttemptAtMs < right.NextAttemptAtMs
		}
		return left.CreatedAtMs < right.CreatedAtMs
	})
	if len(eligible) > params.BatchSize {
		eligible = eligible[:params.BatchSize]
	}
	selected := make([]map[string]any, 0, len(eligible))
	for _, item := range eligible {
		selected = append(selected, map[string]any{
			"id":              item.ID,
			"attempts":        item.Attempts + 1,
			"nextAttemptAtMs": nextAttempt(params.Now, item, policy),
		})
	}
	return map[string]any{"selected": selected}, nil
}

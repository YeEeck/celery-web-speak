package store

import "math"

// VoiceLevelFloorXpAt returns the minimum total XP required to reach level L:
// 10*L*L + 40*L (the level formula's per-level threshold). L=0 ⇒ 0.
func VoiceLevelFloorXpAt(level int64) int64 {
	return 10*level*level + 40*level
}

// VoiceProgressAt assembles the server voice level progress projection for a
// given total XP: level with its start/end thresholds. It is the single
// place a VoiceProgress is built from an XP total.
func VoiceProgressAt(xp int64) VoiceProgress {
	level, levelStart, levelEnd := VoiceLevelAt(xp)
	return VoiceProgress{XP: xp, Level: level, LevelStart: levelStart, LevelEnd: levelEnd}
}

// VoiceLevelAt returns (level, levelStartXp, levelEndXp) for a given voice XP
// total. Level L is the largest integer L with 10*L*L + 40*L <= xp. Level L+1
// beings at 10*(L+1)*(L+1) + 40*(L+1).
//
// The level is solved in closed form from the quadratic 10*L^2 + 40*L - xp
// <= 0, then corrected for float64 drift by check-and-adjust loops. This is
// O(1), exact, and stays correct for any int64 XP up to ~9.2e18 (the sqrt
// never overflows float64 for in-range XP; the adjust loops tighten any
// rounding slope to the true integer L).
func VoiceLevelAt(xp int64) (level, levelStartXp, levelEndXp int64) {
	if xp < 0 {
		xp = 0
	}
	l := int64(math.Floor((math.Sqrt(1600+40*float64(xp)) - 40) / 20))
	if l < 0 {
		l = 0
	}
	// Drift dodge: decrement while L overshoots the threshold.
	for l > 0 && VoiceLevelFloorXpAt(l) > xp {
		l--
	}
	// Drift dodge: ascend while L+1 is already reached (floor undershoot).
	for VoiceLevelFloorXpAt(l+1) <= xp {
		l++
	}
	return l, VoiceLevelFloorXpAt(l), VoiceLevelFloorXpAt(l + 1)
}
package memory

import (
	"regexp"
	"strings"
	"unicode"
)

const (
	PrefPunctuation = "punctuation"
	PrefEndPeriod   = "end_period"
	PrefListStyle   = "list_style"
	PrefCNSpace     = "cn_en_space"
)

type Preference struct {
	UserID string `json:"user_id,omitempty"`
	Key    string `json:"key"`
	Value  string `json:"value"`
}

var preferenceKeys = []string{PrefPunctuation, PrefEndPeriod, PrefListStyle, PrefCNSpace}

var chinesePunct = "，。！？；：、"
var englishPunct = ",.!?;:"

func DetectPreferences(llmOutput, userFinal string) []Preference {
	llmOutput = strings.TrimSpace(llmOutput)
	userFinal = strings.TrimSpace(userFinal)
	if llmOutput == "" || userFinal == "" {
		return nil
	}

	var prefs []Preference

	if v := detectPunctuation(llmOutput, userFinal); v != "" {
		prefs = append(prefs, Preference{Key: PrefPunctuation, Value: v})
	}
	if v := detectEndPeriod(llmOutput, userFinal); v != "" {
		prefs = append(prefs, Preference{Key: PrefEndPeriod, Value: v})
	}
	if v := detectListStyle(llmOutput, userFinal); v != "" {
		prefs = append(prefs, Preference{Key: PrefListStyle, Value: v})
	}
	if v := detectCNSpace(llmOutput, userFinal); v != "" {
		prefs = append(prefs, Preference{Key: PrefCNSpace, Value: v})
	}
	return prefs
}

func PreferenceLabel(key, value string) string {
	switch key {
	case PrefPunctuation:
		if value == "chinese" {
			return "中文标点"
		}
		return "英文标点"
	case PrefEndPeriod:
		if value == "always" {
			return "句末加句号"
		}
		return "句末不加句号"
	case PrefListStyle:
		if value == "numbered" {
			return "数字列表"
		}
		return "短横列表"
	case PrefCNSpace:
		if value == "true" {
			return "中英文间加空格"
		}
		return "中英文间不加空格"
	}
	return key + "=" + value
}

func PreferencesToPrompt(prefs []Preference) string {
	if len(prefs) == 0 {
		return ""
	}
	parts := make([]string, 0, len(prefs))
	for _, p := range prefs {
		parts = append(parts, PreferenceLabel(p.Key, p.Value))
	}
	return "用户格式偏好：" + strings.Join(parts, "；") + "。"
}

func detectPunctuation(before, after string) string {
	cBefore := countAny(before, chinesePunct)
	eBefore := countAny(before, englishPunct)
	cAfter := countAny(after, chinesePunct)
	eAfter := countAny(after, englishPunct)

	if (cAfter - cBefore) > (eAfter - eBefore) {
		return "chinese"
	}
	if (eAfter - eBefore) > (cAfter - cBefore) {
		return "english"
	}
	return ""
}

func detectEndPeriod(before, after string) string {
	beforeHas := endsWithPunct(before)
	afterHas := endsWithPunct(after)
	if !beforeHas && afterHas {
		return "always"
	}
	if beforeHas && !afterHas {
		return "never"
	}
	return ""
}

func detectListStyle(before, after string) string {
	dashBefore := countDash(before)
	dashAfter := countDash(after)
	numBefore := countNumbered(before)
	numAfter := countNumbered(after)

	if (dashBefore > 0 || numBefore > 0) && numAfter > numBefore {
		return "numbered"
	}
	if (dashBefore > 0 || numBefore > 0) && dashAfter > dashBefore {
		return "dash"
	}
	return ""
}

func detectCNSpace(before, after string) string {
	beforeHas := hasCNEnNoSpace(before)
	afterHas := hasCNEnNoSpace(after)
	if beforeHas && !afterHas {
		return "true"
	}
	if !beforeHas && afterHas {
		return "false"
	}
	return ""
}

func hasCNEnNoSpace(s string) bool {
	runes := []rune(s)
	for i := 0; i < len(runes)-1; i++ {
		if unicode.Is(unicode.Han, runes[i]) && isASCIIAlnum(runes[i+1]) {
			return true
		}
		if isASCIIAlnum(runes[i]) && unicode.Is(unicode.Han, runes[i+1]) {
			return true
		}
	}
	return false
}

var listDashRe = regexp.MustCompile(`(?m)^[-*]\s`)
var listNumberedRe = regexp.MustCompile(`(?m)^\d+[.、]\s`)

func countDash(s string) int {
	return len(listDashRe.FindAllString(s, -1))
}

func countNumbered(s string) int {
	return len(listNumberedRe.FindAllString(s, -1))
}

func endsWithPunct(s string) bool {
	if s == "" {
		return false
	}
	last := []rune(s)[len([]rune(s))-1]
	return strings.ContainsRune("。.!?！？", last)
}

func countAny(s, chars string) int {
	n := 0
	for _, r := range s {
		if strings.ContainsRune(chars, r) {
			n++
		}
	}
	return n
}

func isASCIIAlnum(r rune) bool {
	return (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9')
}

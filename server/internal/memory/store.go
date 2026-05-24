package memory

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"
	"unicode"

	_ "modernc.org/sqlite"
)

type Store struct {
	db *sql.DB
}

type Correction struct {
	UserID        string `json:"user_id"`
	SessionID     string `json:"session_id,omitempty"`
	OriginalText  string `json:"original_text"`
	EnhancedText  string `json:"enhanced_text,omitempty"`
	CorrectedText string `json:"corrected_text"`
}

type Mapping struct {
	ID              int64  `json:"id"`
	UserID          string `json:"user_id,omitempty"`
	FromText        string `json:"from_text"`
	ToText          string `json:"to_text"`
	CorrectionCount int    `json:"correction_count"`
	HitCount        int    `json:"hit_count"`
	CreatedAt       string `json:"created_at,omitempty"`
	UpdatedAt       string `json:"updated_at,omitempty"`
}

func Open(path string) (*Store, error) {
	if strings.TrimSpace(path) == "" {
		return nil, errors.New("database path is required")
	}
	if path != ":memory:" {
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			return nil, fmt.Errorf("create database directory: %w", err)
		}
	}

	db, err := sql.Open("sqlite", path)
	if err != nil {
		return nil, fmt.Errorf("open sqlite database: %w", err)
	}
	db.SetMaxOpenConns(1)

	store := &Store{db: db}
	if err := store.migrate(context.Background()); err != nil {
		_ = db.Close()
		return nil, err
	}
	return store, nil
}

func (s *Store) Close() error {
	if s == nil || s.db == nil {
		return nil
	}
	return s.db.Close()
}

func (s *Store) migrate(ctx context.Context) error {
	statements := []string{
		`PRAGMA busy_timeout = 5000`,
		`PRAGMA journal_mode = WAL`,
		`CREATE TABLE IF NOT EXISTS users (
			id TEXT PRIMARY KEY,
			created_at TEXT NOT NULL,
			last_seen_at TEXT NOT NULL
		)`,
		`CREATE TABLE IF NOT EXISTS corrections (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			user_id TEXT NOT NULL,
			session_id TEXT,
			original_text TEXT NOT NULL,
			enhanced_text TEXT,
			corrected_text TEXT NOT NULL,
			created_at TEXT NOT NULL
		)`,
		`CREATE TABLE IF NOT EXISTS hotword_mappings (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			user_id TEXT NOT NULL,
			from_text TEXT NOT NULL,
			to_text TEXT NOT NULL,
			correction_count INTEGER NOT NULL DEFAULT 1,
			hit_count INTEGER NOT NULL DEFAULT 0,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL,
			UNIQUE(user_id, from_text, to_text)
		)`,
		`CREATE TABLE IF NOT EXISTS user_preferences (
			user_id TEXT NOT NULL,
			key TEXT NOT NULL,
			value TEXT NOT NULL,
			updated_at TEXT NOT NULL,
			PRIMARY KEY(user_id, key)
		)`,
	}

	for _, statement := range statements {
		if _, err := s.db.ExecContext(ctx, statement); err != nil {
			return fmt.Errorf("migrate sqlite database: %w", err)
		}
	}
	return nil
}

func (s *Store) EnsureUser(ctx context.Context, userID string) error {
	userID = strings.TrimSpace(userID)
	if userID == "" {
		return errors.New("user_id is required")
	}

	now := timestamp()
	_, err := s.db.ExecContext(ctx, `
		INSERT INTO users (id, created_at, last_seen_at)
		VALUES (?, ?, ?)
		ON CONFLICT(id) DO UPDATE SET last_seen_at = excluded.last_seen_at
	`, userID, now, now)
	if err != nil {
		return fmt.Errorf("ensure user: %w", err)
	}
	return nil
}

func (s *Store) SaveCorrection(ctx context.Context, correction Correction) ([]Mapping, error) {
	correction.UserID = strings.TrimSpace(correction.UserID)
	correction.OriginalText = strings.TrimSpace(correction.OriginalText)
	correction.EnhancedText = strings.TrimSpace(correction.EnhancedText)
	correction.CorrectedText = strings.TrimSpace(correction.CorrectedText)

	if correction.UserID == "" {
		return nil, errors.New("user_id is required")
	}
	if correction.OriginalText == "" && correction.EnhancedText == "" {
		return nil, errors.New("original_text is required")
	}
	if correction.CorrectedText == "" {
		return nil, errors.New("corrected_text is required")
	}

	if err := s.EnsureUser(ctx, correction.UserID); err != nil {
		return nil, err
	}

	now := timestamp()
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, fmt.Errorf("begin correction transaction: %w", err)
	}
	defer tx.Rollback()

	exists, err := correctionExists(ctx, tx, correction)
	if err != nil {
		return nil, err
	}
	if exists {
		return nil, nil
	}

	if _, err := tx.ExecContext(ctx, `
		INSERT INTO corrections (user_id, session_id, original_text, enhanced_text, corrected_text, created_at)
		VALUES (?, ?, ?, ?, ?, ?)
	`, correction.UserID, correction.SessionID, correction.OriginalText, correction.EnhancedText, correction.CorrectedText, now); err != nil {
		return nil, fmt.Errorf("insert correction: %w", err)
	}

	baseText := correction.EnhancedText
	if baseText == "" {
		baseText = correction.OriginalText
	}
	candidates := ExtractMappings(baseText, correction.CorrectedText)
	saved := make([]Mapping, 0, len(candidates))
	for _, candidate := range candidates {
		mapping, err := upsertMapping(ctx, tx, correction.UserID, candidate.FromText, candidate.ToText, now)
		if err != nil {
			return nil, err
		}
		saved = append(saved, mapping)
	}

	if err := tx.Commit(); err != nil {
		return nil, fmt.Errorf("commit correction transaction: %w", err)
	}
	return saved, nil
}

func correctionExists(ctx context.Context, tx *sql.Tx, correction Correction) (bool, error) {
	var id int64
	err := tx.QueryRowContext(ctx, `
		SELECT id
		FROM corrections
		WHERE user_id = ?
			AND COALESCE(session_id, '') = ?
			AND original_text = ?
			AND COALESCE(enhanced_text, '') = ?
			AND corrected_text = ?
		LIMIT 1
	`, correction.UserID, correction.SessionID, correction.OriginalText, correction.EnhancedText, correction.CorrectedText).Scan(&id)
	if err == nil {
		return true, nil
	}
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	return false, fmt.Errorf("check duplicate correction: %w", err)
}

func (s *Store) ApplyMappings(ctx context.Context, userID string, input string) (string, []Mapping, error) {
	userID = strings.TrimSpace(userID)
	if userID == "" || strings.TrimSpace(input) == "" {
		return input, nil, nil
	}

	rows, err := s.db.QueryContext(ctx, `
		SELECT id, user_id, from_text, to_text, correction_count, hit_count, created_at, updated_at
		FROM hotword_mappings
		WHERE user_id = ?
		ORDER BY length(from_text) DESC, correction_count DESC, id ASC
	`, userID)
	if err != nil {
		return input, nil, fmt.Errorf("query mappings: %w", err)
	}

	mappings := []Mapping{}
	for rows.Next() {
		var mapping Mapping
		if err := rows.Scan(&mapping.ID, &mapping.UserID, &mapping.FromText, &mapping.ToText, &mapping.CorrectionCount, &mapping.HitCount, &mapping.CreatedAt, &mapping.UpdatedAt); err != nil {
			_ = rows.Close()
			return input, nil, fmt.Errorf("scan mapping: %w", err)
		}
		mappings = append(mappings, mapping)
	}
	if err := rows.Err(); err != nil {
		_ = rows.Close()
		return input, nil, fmt.Errorf("iterate mappings: %w", err)
	}
	if err := rows.Close(); err != nil {
		return input, nil, fmt.Errorf("close mapping rows: %w", err)
	}

	output := input
	hits := []Mapping{}
	for _, mapping := range mappings {
		if mapping.FromText == "" || mapping.FromText == mapping.ToText {
			continue
		}
		count := strings.Count(output, mapping.FromText)
		if count == 0 {
			continue
		}
		output = strings.ReplaceAll(output, mapping.FromText, mapping.ToText)
		mapping.HitCount += count
		hits = append(hits, mapping)
		if _, err := s.db.ExecContext(ctx, `
			UPDATE hotword_mappings
			SET hit_count = hit_count + ?, updated_at = ?
			WHERE id = ?
		`, count, timestamp(), mapping.ID); err != nil {
			return input, nil, fmt.Errorf("update mapping hit count: %w", err)
		}
	}
	return output, hits, nil
}

func (s *Store) ListMappings(ctx context.Context, userID string) ([]Mapping, error) {
	userID = strings.TrimSpace(userID)
	if userID == "" {
		return nil, errors.New("user_id is required")
	}

	rows, err := s.db.QueryContext(ctx, `
		SELECT id, user_id, from_text, to_text, correction_count, hit_count, created_at, updated_at
		FROM hotword_mappings
		WHERE user_id = ?
		ORDER BY correction_count DESC, hit_count DESC, updated_at DESC, id DESC
		LIMIT 50
	`, userID)
	if err != nil {
		return nil, fmt.Errorf("list mappings: %w", err)
	}
	defer rows.Close()

	var mappings []Mapping
	for rows.Next() {
		var mapping Mapping
		if err := rows.Scan(&mapping.ID, &mapping.UserID, &mapping.FromText, &mapping.ToText, &mapping.CorrectionCount, &mapping.HitCount, &mapping.CreatedAt, &mapping.UpdatedAt); err != nil {
			return nil, fmt.Errorf("scan mapping: %w", err)
		}
		mappings = append(mappings, mapping)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate mappings: %w", err)
	}
	return mappings, nil
}

func (s *Store) DeleteMapping(ctx context.Context, userID string, id int64) error {
	userID = strings.TrimSpace(userID)
	if userID == "" {
		return errors.New("user_id is required")
	}
	result, err := s.db.ExecContext(ctx, `DELETE FROM hotword_mappings WHERE user_id = ? AND id = ?`, userID, id)
	if err != nil {
		return fmt.Errorf("delete mapping: %w", err)
	}
	deleted, err := result.RowsAffected()
	if err != nil {
		return fmt.Errorf("read deleted mapping count: %w", err)
	}
	if deleted == 0 {
		return sql.ErrNoRows
	}
	return nil
}

func (s *Store) SavePreference(ctx context.Context, userID string, key string, value string) error {
	userID = strings.TrimSpace(userID)
	key = strings.TrimSpace(key)
	value = strings.TrimSpace(value)
	if userID == "" || key == "" || value == "" {
		return nil
	}
	if err := s.EnsureUser(ctx, userID); err != nil {
		return err
	}

	now := timestamp()
	_, err := s.db.ExecContext(ctx, `
		INSERT INTO user_preferences (user_id, key, value, updated_at)
		VALUES (?, ?, ?, ?)
		ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
	`, userID, key, value, now)
	if err != nil {
		return fmt.Errorf("save preference: %w", err)
	}
	return nil
}

func (s *Store) SaveFormatPreferences(ctx context.Context, userID string, llmOutput string, userFinal string) error {
	for _, pref := range DetectPreferences(llmOutput, userFinal) {
		if err := s.SavePreference(ctx, userID, pref.Key, pref.Value); err != nil {
			return err
		}
	}
	return nil
}

func (s *Store) ListPreferences(ctx context.Context, userID string) ([]Preference, error) {
	userID = strings.TrimSpace(userID)
	if userID == "" {
		return nil, nil
	}

	rows, err := s.db.QueryContext(ctx, `
		SELECT user_id, key, value
		FROM user_preferences
		WHERE user_id = ?
		ORDER BY key
	`, userID)
	if err != nil {
		return nil, fmt.Errorf("list preferences: %w", err)
	}
	defer rows.Close()

	var prefs []Preference
	for rows.Next() {
		var pref Preference
		if err := rows.Scan(&pref.UserID, &pref.Key, &pref.Value); err != nil {
			return nil, fmt.Errorf("scan preference: %w", err)
		}
		prefs = append(prefs, pref)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate preferences: %w", err)
	}
	return prefs, nil
}

func (s *Store) DeletePreference(ctx context.Context, userID string, key string) error {
	userID = strings.TrimSpace(userID)
	key = strings.TrimSpace(key)
	if userID == "" || key == "" {
		return nil
	}

	result, err := s.db.ExecContext(ctx, `DELETE FROM user_preferences WHERE user_id = ? AND key = ?`, userID, key)
	if err != nil {
		return fmt.Errorf("delete preference: %w", err)
	}
	deleted, err := result.RowsAffected()
	if err != nil {
		return fmt.Errorf("read deleted preference count: %w", err)
	}
	if deleted == 0 {
		return sql.ErrNoRows
	}
	return nil
}

func ExtractMappings(original string, corrected string) []Mapping {
	original = strings.TrimSpace(original)
	corrected = strings.TrimSpace(corrected)
	if original == "" || corrected == "" || original == corrected {
		return nil
	}

	if changeRatioTooHigh(original, corrected) {
		return nil
	}

	from, to := changedSpan(original, corrected)
	if !validMapping(from, to) {
		return nil
	}
	return []Mapping{{FromText: from, ToText: to}}
}

func changedSpan(original string, corrected string) (string, string) {
	fromRunes := []rune(original)
	toRunes := []rune(corrected)

	prefix := 0
	for prefix < len(fromRunes) && prefix < len(toRunes) && fromRunes[prefix] == toRunes[prefix] {
		prefix++
	}

	suffix := 0
	for suffix < len(fromRunes)-prefix && suffix < len(toRunes)-prefix &&
		fromRunes[len(fromRunes)-1-suffix] == toRunes[len(toRunes)-1-suffix] {
		suffix++
	}

	fromStart := prefix
	toStart := prefix
	fromEnd := len(fromRunes) - suffix
	toEnd := len(toRunes) - suffix

	for (fromEnd-fromStart < 2 || toEnd-toStart < 2) && fromStart > 0 && toStart > 0 {
		fromStart--
		toStart--
	}
	for (fromEnd-fromStart < 2 || toEnd-toStart < 2) && fromEnd < len(fromRunes) && toEnd < len(toRunes) {
		fromEnd++
		toEnd++
	}

	return strings.Trim(strings.TrimSpace(string(fromRunes[fromStart:fromEnd])), "，。,.!?！？；;：:、 "),
		strings.Trim(strings.TrimSpace(string(toRunes[toStart:toEnd])), "，。,.!?！？；;：:、 ")
}

func upsertMapping(ctx context.Context, tx *sql.Tx, userID string, fromText string, toText string, now string) (Mapping, error) {
	if _, err := tx.ExecContext(ctx, `
		DELETE FROM hotword_mappings
		WHERE user_id = ? AND from_text = ? AND to_text <> ?
	`, userID, fromText, toText); err != nil {
		return Mapping{}, fmt.Errorf("delete conflicting mapping: %w", err)
	}

	if _, err := tx.ExecContext(ctx, `
		INSERT INTO hotword_mappings (user_id, from_text, to_text, correction_count, hit_count, created_at, updated_at)
		VALUES (?, ?, ?, 1, 0, ?, ?)
		ON CONFLICT(user_id, from_text, to_text) DO UPDATE SET
			correction_count = correction_count + 1,
			updated_at = excluded.updated_at
	`, userID, fromText, toText, now, now); err != nil {
		return Mapping{}, fmt.Errorf("upsert mapping: %w", err)
	}

	var mapping Mapping
	if err := tx.QueryRowContext(ctx, `
		SELECT id, user_id, from_text, to_text, correction_count, hit_count, created_at, updated_at
		FROM hotword_mappings
		WHERE user_id = ? AND from_text = ? AND to_text = ?
	`, userID, fromText, toText).Scan(&mapping.ID, &mapping.UserID, &mapping.FromText, &mapping.ToText, &mapping.CorrectionCount, &mapping.HitCount, &mapping.CreatedAt, &mapping.UpdatedAt); err != nil {
		return Mapping{}, fmt.Errorf("read mapping: %w", err)
	}
	return mapping, nil
}

func validMapping(from string, to string) bool {
	from = strings.TrimSpace(from)
	to = strings.TrimSpace(to)
	if from == "" || to == "" || from == to {
		return false
	}
	if strings.ContainsAny(from+to, "\r\n\t") {
		return false
	}

	fromLen := len([]rune(from))
	toLen := len([]rune(to))
	if fromLen < 2 || toLen < 2 || fromLen > 16 || toLen > 16 {
		return false
	}
	if onlyPunctuationOrSpace(from) || onlyPunctuationOrSpace(to) {
		return false
	}
	if !isEntityLike(from) || !isEntityLike(to) {
		return false
	}
	return true
}

func changeRatioTooHigh(original string, corrected string) bool {
	origRunes := []rune(original)
	corrRunes := []rune(corrected)
	maxLen := len(origRunes)
	if len(corrRunes) > maxLen {
		maxLen = len(corrRunes)
	}
	if maxLen == 0 {
		return true
	}
	dist := levenshteinDistance(origRunes, corrRunes)
	return float64(dist)/float64(maxLen) > 0.5
}

func levenshteinDistance(a, b []rune) int {
	if len(a) == 0 {
		return len(b)
	}
	if len(b) == 0 {
		return len(a)
	}

	prev := make([]int, len(b)+1)
	curr := make([]int, len(b)+1)
	for j := 0; j <= len(b); j++ {
		prev[j] = j
	}

	for i := 1; i <= len(a); i++ {
		curr[0] = i
		for j := 1; j <= len(b); j++ {
			cost := 1
			if a[i-1] == b[j-1] {
				cost = 0
			}
			curr[j] = minInt(prev[j]+1, minInt(curr[j-1]+1, prev[j-1]+cost))
		}
		prev, curr = curr, prev
	}
	return prev[len(b)]
}

func minInt(a, b int) int {
	if a < b {
		return a
	}
	return b
}

var functionWordRunes = map[rune]bool{
	'的': true, '了': true, '是': true, '不': true,
	'在': true, '和': true, '与': true, '或': true,
	'也': true, '都': true, '就': true, '才': true,
	'把': true, '被': true, '从': true, '对': true,
	'向': true, '到': true, '给': true, '为': true,
	'以': true, '用': true, '比': true, '让': true,
	'吗': true, '呢': true, '吧': true, '啊': true,
	'哦': true, '嗯': true, '呀': true, '很': true,
	'太': true, '只': true, '个': true, '些': true,
	'这': true, '那': true, '还': true, '又': true,
	'再': true, '会': true, '要': true, '能': true,
	'可': true, '且': true, '而': true, '但': true,
	'因': true, '所': true, '如': true, '若': true,
	'虽': true, '去': true, '来': true, '做': true,
	'搞': true, '弄': true, '有': true, '说': true,
	'想': true, '看': true, '叫': true, '没': true,
	'过': true, '着': true, '得': true, '将': true,
	'已': true, '之': true, '刚': true, '正': true,
}

func isEntityLike(s string) bool {
	runes := []rune(s)
	if len(runes) < 2 || len(runes) > 8 {
		return false
	}
	for _, r := range runes {
		if !unicode.Is(unicode.Han, r) {
			return false
		}
		if functionWordRunes[r] {
			return false
		}
	}
	return true
}

func onlyPunctuationOrSpace(value string) bool {
	for _, r := range value {
		if !unicode.IsPunct(r) && !unicode.IsSpace(r) {
			return false
		}
	}
	return true
}

func timestamp() string {
	return time.Now().UTC().Format(time.RFC3339Nano)
}

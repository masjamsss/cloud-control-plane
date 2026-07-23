package hclops

import (
	"bytes"
	"strconv"
	"strings"
)

const diffContext = 3

type etag int

const (
	eqTag etag = iota
	delTag
	insTag
)

type edit struct {
	tag    etag
	ai, bi int // 0-based line indices into a/b; -1 when not applicable
}

func splitLines(b []byte) (lines []string, eofNL bool) {
	if len(b) == 0 {
		return nil, true
	}
	s := string(b)
	eofNL = strings.HasSuffix(s, "\n")
	if eofNL {
		s = s[:len(s)-1]
	}
	return strings.Split(s, "\n"), eofNL
}

// UnifiedDiff returns a deterministic unified diff between a and b: 3 lines of
// context, git-style `--- a/…` / `+++ b/…` labels, and `@@ -l,n +l,n @@` hunks
// with the `,1` count omitted (git/difflib convention). Empty when a == b.
func UnifiedDiff(aPath, bPath string, a, b []byte) []byte {
	if bytes.Equal(a, b) {
		return nil
	}
	aLines, aNL := splitLines(a)
	bLines, bNL := splitLines(b)
	edits := computeEdits(aLines, bLines)
	hunks := groupHunks(edits, diffContext)
	if len(hunks) == 0 {
		return nil
	}
	var out bytes.Buffer
	out.WriteString("--- a/" + aPath + "\n")
	out.WriteString("+++ b/" + bPath + "\n")
	for _, h := range hunks {
		writeHunk(&out, edits[h[0]:h[1]], aLines, bLines, aNL, bNL, len(aLines), len(bLines))
	}
	return out.Bytes()
}

// computeEdits trims the common line prefix/suffix (keeping the expensive LCS
// bounded to the changed middle) then splices the three segments together.
func computeEdits(a, b []string) []edit {
	n, m := len(a), len(b)
	lo := 0
	for lo < n && lo < m && a[lo] == b[lo] {
		lo++
	}
	aHi, bHi := n, m
	for aHi > lo && bHi > lo && a[aHi-1] == b[bHi-1] {
		aHi--
		bHi--
	}
	edits := make([]edit, 0, n+m)
	for i := 0; i < lo; i++ {
		edits = append(edits, edit{eqTag, i, i})
	}
	edits = append(edits, lcsEdits(a, b, lo, aHi, lo, bHi)...)
	for i := aHi; i < n; i++ {
		edits = append(edits, edit{eqTag, i, bHi + (i - aHi)})
	}
	return edits
}

func lcsEdits(a, b []string, aLo, aHi, bLo, bHi int) []edit {
	n, m := aHi-aLo, bHi-bLo
	if n == 0 && m == 0 {
		return nil
	}
	dp := make([][]int, n+1)
	for i := range dp {
		dp[i] = make([]int, m+1)
	}
	for i := n - 1; i >= 0; i-- {
		for j := m - 1; j >= 0; j-- {
			switch {
			case a[aLo+i] == b[bLo+j]:
				dp[i][j] = dp[i+1][j+1] + 1
			case dp[i+1][j] >= dp[i][j+1]:
				dp[i][j] = dp[i+1][j]
			default:
				dp[i][j] = dp[i][j+1]
			}
		}
	}
	var edits []edit
	i, j := 0, 0
	for i < n && j < m {
		switch {
		case a[aLo+i] == b[bLo+j]:
			edits = append(edits, edit{eqTag, aLo + i, bLo + j})
			i++
			j++
		case dp[i+1][j] >= dp[i][j+1]:
			edits = append(edits, edit{delTag, aLo + i, -1})
			i++
		default:
			edits = append(edits, edit{insTag, -1, bLo + j})
			j++
		}
	}
	for ; i < n; i++ {
		edits = append(edits, edit{delTag, aLo + i, -1})
	}
	for ; j < m; j++ {
		edits = append(edits, edit{insTag, -1, bLo + j})
	}
	return edits
}

func groupHunks(edits []edit, ctx int) [][2]int {
	var changes []int
	for i, e := range edits {
		if e.tag != eqTag {
			changes = append(changes, i)
		}
	}
	if len(changes) == 0 {
		return nil
	}
	clamp := func(x int) int {
		if x < 0 {
			return 0
		}
		if x > len(edits) {
			return len(edits)
		}
		return x
	}
	var hunks [][2]int
	start := clamp(changes[0] - ctx)
	end := clamp(changes[0] + ctx + 1)
	for _, c := range changes[1:] {
		if c-ctx <= end {
			end = clamp(c + ctx + 1)
		} else {
			hunks = append(hunks, [2]int{start, end})
			start = clamp(c - ctx)
			end = clamp(c + ctx + 1)
		}
	}
	return append(hunks, [2]int{start, end})
}

func writeHunk(out *bytes.Buffer, hunk []edit, aLines, bLines []string, aNL, bNL bool, aTotal, bTotal int) {
	aStart, aCount, bStart, bCount := 0, 0, 0, 0
	for _, e := range hunk {
		if e.tag == eqTag || e.tag == delTag {
			if aCount == 0 {
				aStart = e.ai + 1
			}
			aCount++
		}
		if e.tag == eqTag || e.tag == insTag {
			if bCount == 0 {
				bStart = e.bi + 1
			}
			bCount++
		}
	}
	// Pure-insertion hunks anchor at the preceding line (GNU `-N,0` convention).
	out.WriteString("@@ -" + rng(aStart, aCount) + " +" + rng(bStart, bCount) + " @@\n")
	for _, e := range hunk {
		switch e.tag {
		case eqTag:
			out.WriteByte(' ')
			out.WriteString(aLines[e.ai])
			out.WriteByte('\n')
			if e.ai == aTotal-1 && !aNL {
				out.WriteString("\\ No newline at end of file\n")
			}
		case delTag:
			out.WriteByte('-')
			out.WriteString(aLines[e.ai])
			out.WriteByte('\n')
			if e.ai == aTotal-1 && !aNL {
				out.WriteString("\\ No newline at end of file\n")
			}
		case insTag:
			out.WriteByte('+')
			out.WriteString(bLines[e.bi])
			out.WriteByte('\n')
			if e.bi == bTotal-1 && !bNL {
				out.WriteString("\\ No newline at end of file\n")
			}
		}
	}
}

func rng(start, count int) string {
	if count == 1 {
		return strconv.Itoa(start)
	}
	return strconv.Itoa(start) + "," + strconv.Itoa(count)
}

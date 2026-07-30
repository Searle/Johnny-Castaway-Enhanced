// Package main — blast.go: a PKWARE Data Compression Library "implode"
// decompressor (a Go port of Mark Adler's public-domain blast.c). Used to
// decompress the InstallShield-Z compressed RESOURCE.00$ from the original
// Screen Antics install disk.
package main

import "errors"

const (
	blastMaxBits = 13
)

var errBlastEOF = errors.New("blast: out of input")

func blastConstruct(rep []byte) (count []int, symbol []int) {
	var length []int
	for _, b := range rep {
		n := int(b>>4) + 1
		l := int(b & 0x0F)
		for i := 0; i < n; i++ {
			length = append(length, l)
		}
	}
	count = make([]int, blastMaxBits+1)
	for _, l := range length {
		count[l]++
	}
	offs := make([]int, blastMaxBits+2)
	for i := 1; i < blastMaxBits; i++ {
		offs[i+1] = offs[i] + count[i]
	}
	symbol = make([]int, len(length))
	for sym, l := range length {
		if l != 0 {
			symbol[offs[l]] = sym
			offs[l]++
		}
	}
	return count, symbol
}

var (
	blastLitLen = []byte{11, 124, 8, 7, 28, 7, 188, 13, 76, 4, 10, 8, 12, 10, 12, 10, 8, 23, 8,
		9, 7, 6, 7, 8, 7, 6, 55, 8, 23, 24, 12, 11, 7, 9, 11, 12, 6, 7, 22, 5, 7, 24, 6, 11, 9, 6,
		7, 22, 7, 11, 38, 7, 9, 8, 25, 11, 8, 11, 9, 12, 8, 12, 5, 38, 5, 38, 5, 11, 7, 5, 6, 21,
		6, 10, 53, 8, 7, 24, 10, 27, 44, 253, 253, 253, 252, 252, 252, 13, 12, 45, 12, 45,
		12, 61, 12, 45, 44, 173}
	blastLenLen  = []byte{2, 35, 36, 53, 38, 23}
	blastDistLen = []byte{2, 20, 53, 230, 247, 151, 248}

	blastLitCnt, blastLitSym   = blastConstruct(blastLitLen)
	blastLenCnt, blastLenSym   = blastConstruct(blastLenLen)
	blastDistCnt, blastDistSym = blastConstruct(blastDistLen)

	blastBase  = []int{3, 2, 4, 5, 6, 7, 8, 9, 10, 12, 16, 24, 40, 72, 136, 264}
	blastExtra = []int{0, 0, 0, 0, 0, 0, 0, 0, 1, 2, 3, 4, 5, 6, 7, 8}
)

type blastState struct {
	data   []byte
	pos    int
	bitbuf int
	bitcnt int
	out    []byte
}

func (s *blastState) bits(need int) (int, error) {
	val := s.bitbuf
	for s.bitcnt < need {
		if s.pos >= len(s.data) {
			return 0, errBlastEOF
		}
		val |= int(s.data[s.pos]) << s.bitcnt
		s.pos++
		s.bitcnt += 8
	}
	s.bitbuf = val >> need
	s.bitcnt -= need
	return val & ((1 << need) - 1), nil
}

func (s *blastState) decode(count, symbol []int) (int, error) {
	bitbuf := s.bitbuf
	left := s.bitcnt
	code, first, index := 0, 0, 0
	length := 1
	next := 1
	for {
		for left > 0 {
			left--
			code |= (bitbuf & 1) ^ 1
			bitbuf >>= 1
			cnt := count[next]
			next++
			if code < first+cnt {
				s.bitbuf = bitbuf
				s.bitcnt = (s.bitcnt - length) & 7
				return symbol[index+(code-first)], nil
			}
			index += cnt
			first += cnt
			first <<= 1
			code <<= 1
			length++
		}
		left = (blastMaxBits + 1) - length
		if left == 0 {
			break
		}
		if s.pos >= len(s.data) {
			return 0, errBlastEOF
		}
		bitbuf = int(s.data[s.pos])
		s.pos++
		if left > 8 {
			left = 8
		}
	}
	return -9, nil
}

// blast decompresses a PKWARE-imploded stream starting at data[0].
func blast(data []byte) ([]byte, error) {
	s := &blastState{data: data}
	lit, err := s.bits(8)
	if err != nil {
		return nil, err
	}
	if lit > 1 {
		return nil, errors.New("blast: bad lit flag")
	}
	dict, err := s.bits(8)
	if err != nil {
		return nil, err
	}
	if dict < 4 || dict > 6 {
		return nil, errors.New("blast: bad dict size")
	}
	for {
		coded, err := s.bits(1)
		if err != nil {
			return nil, err
		}
		if coded != 0 {
			sym, err := s.decode(blastLenCnt, blastLenSym)
			if err != nil {
				return nil, err
			}
			extra, err := s.bits(blastExtra[sym])
			if err != nil {
				return nil, err
			}
			length := blastBase[sym] + extra
			if length == 519 {
				break // end of stream
			}
			symb := dict
			if length == 2 {
				symb = 2
			}
			dsym, err := s.decode(blastDistCnt, blastDistSym)
			if err != nil {
				return nil, err
			}
			dist := dsym << symb
			extraD, err := s.bits(symb)
			if err != nil {
				return nil, err
			}
			dist += extraD + 1
			for i := 0; i < length; i++ {
				s.out = append(s.out, s.out[len(s.out)-dist])
			}
		} else {
			var sym int
			if lit != 0 {
				sym, err = s.decode(blastLitCnt, blastLitSym)
			} else {
				sym, err = s.bits(8)
			}
			if err != nil {
				return nil, err
			}
			s.out = append(s.out, byte(sym))
		}
	}
	return s.out, nil
}

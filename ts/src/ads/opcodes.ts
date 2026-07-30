// ADS opcodes, transcribed from the Go adsPlayChunk switch (ads.go). Opcodes
// not listed here are :TAG markers — the opcode value itself is the tag id.

export const AdsOp = {
  IF_LASTPLAYED_LOCAL: 0x1070,
  IF_UNKNOWN_1: 0x1330, // treated as a no-op (see ads.go note)
  IF_LASTPLAYED: 0x1350,
  IF_NOT_RUNNING: 0x1360,
  IF_IS_RUNNING: 0x1370,
  AND: 0x1420,
  OR: 0x1430,
  PLAY_SCENE: 0x1510,
  ADD_SCENE_LOCAL: 0x1520,
  ADD_SCENE: 0x2005,
  STOP_SCENE: 0x2010,
  UNKNOWN_2014: 0x2014,
  RANDOM_START: 0x3010,
  NOP: 0x3020,
  RANDOM_END: 0x30ff,
  UNKNOWN_6: 0x4000,
  FADE_OUT: 0xf010,
  GOSUB_TAG: 0xf200,
  END: 0xffff,
  END_IF: 0xfff0,
} as const;

// Opcodes handled by the interpreter (everything else is a tag marker).
export const ADS_OPCODES = new Set<number>(Object.values(AdsOp));

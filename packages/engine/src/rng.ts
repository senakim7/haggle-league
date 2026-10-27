// 같은 시드면 같은 경기가 나와야 하므로 Math.random 대신 시드 기반 난수를 쓴다.

export type Rng = () => number;

// mulberry32: 32비트 시드에서 [0, 1) 실수를 만든다.
export function createRng(seed: number): Rng {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// 기준 시드와 순번으로 서로 겹치지 않는 하위 시드를 만든다(라운드의 n번째 대결 등).
export function deriveSeed(base: number, index: number): number {
  let h = (base ^ Math.imul(index + 1, 0x9e3779b9)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

export function uniform(rng: Rng, min: number, max: number): number {
  return min + (max - min) * rng();
}

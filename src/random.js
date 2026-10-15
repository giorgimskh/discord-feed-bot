export function sampleRandom(array, n) {
  const pool = array.slice();
  const count = Math.min(n, pool.length);
  const result = [];
  for (let i = 0; i < count; i++) {
    const idx = Math.floor(Math.random() * pool.length);
    result.push(pool.splice(idx, 1)[0]);
  }
  return result;
}

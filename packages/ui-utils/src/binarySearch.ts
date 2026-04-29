type Comparer<T, U> = (item: T, target: U) => number;
// return:
//   < 0 → item < target
//   0   → equal
//   > 0 → item > target

export function binarySearch<T, U>(
  arr: T[],
  target: U,
  compare: Comparer<T, U>
): number {
  let low = 0;
  let high = arr.length - 1;

  while (low <= high) {
    const mid = (low + high) >>> 1;
    const cmp = compare(arr[mid], target);

    if (cmp === 0) return mid;
    if (cmp < 0) low = mid + 1;
    else high = mid - 1;
  }

  // not found → return ~insertionIndex
  return ~low;
}
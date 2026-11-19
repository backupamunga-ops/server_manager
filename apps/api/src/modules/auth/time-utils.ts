/** Small date utility to avoid pulling a date library. */
export function addMinutes(date: Date, minutes: number): Date {
  return new Date(date.getTime() + minutes * 60_000);
}

export function addSeconds(date: Date, seconds: number): Date {
  return new Date(date.getTime() + seconds * 1000);
}

export function isExpired(date: Date): boolean {
  return date.getTime() <= Date.now();
}

export function rfc3339(date: Date): string {
  return date.toISOString();
}

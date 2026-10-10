// Calendar dates are plain YYYY-MM-DD strings without a time zone. Arithmetic uses day
// numbers (days since 1970-01-01) so daylight-saving changes never shift a task's day.
// PlannerDates.kt uses java.time.LocalDate with the same results.

const pattern = /^(\d{4})-(\d{2})-(\d{2})$/;

export function daysInMonth(year: number, month: number): number {
  return month === 2 ? (year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28) : [4, 6, 9, 11].includes(month) ? 30 : 31;
}

export function validDate(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match = pattern.exec(value);
  if (!match) return false;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  return year >= 1000 && month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth(year, month);
}

export function dayNumber(date: string): number {
  const [year, month, day] = date.split('-').map(Number);
  const y = year - (month <= 2 ? 1 : 0);
  const era = Math.floor(y / 400), yoe = y - era * 400;
  const doy = Math.floor((153 * (month + (month > 2 ? -3 : 9)) + 2) / 5) + day - 1;
  return era * 146097 + yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy - 719468;
}

export function fromDayNumber(days: number): string {
  const z = days + 719468, era = Math.floor(z / 146097), doe = z - era * 146097;
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153), day = doy - Math.floor((153 * mp + 2) / 5) + 1, month = mp + (mp < 10 ? 3 : -9);
  return dateOf(yoe + era * 400 + (month <= 2 ? 1 : 0), month, day);
}

export function dateOf(year: number, month: number, day: number): string {
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

export const addDays = (date: string, days: number) => fromDayNumber(dayNumber(date) + days);

/** ISO weekday: Monday is 1 and Sunday is 7. */
export const weekday = (date: string) => ((dayNumber(date) % 7) + 10) % 7 + 1;

export function localToday(now = new Date()): string {
  return dateOf(now.getFullYear(), now.getMonth() + 1, now.getDate());
}

/** The 42 days (six Monday-first weeks) shown for a month. */
export function monthGrid(year: number, month: number): string[] {
  const first = dateOf(year, month, 1);
  const start = dayNumber(first) - (weekday(first) - 1);
  return Array.from({ length: 42 }, (_, index) => fromDayNumber(start + index));
}

export const weekdayNames = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
export const monthNames = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
export const ordinals = ['first', 'second', 'third', 'fourth'];

import { describe, expect, it } from 'vitest';
import { formatMoney, parseMoney, paiseToInput } from '../src/utils/money.js';
import { formatQty, parseQty, formatRateBp } from '../src/utils/qty.js';
import { formatDate } from '../src/utils/dates.js';

describe('money', () => {
  it('formats paise with Indian grouping', () => {
    expect(formatMoney(12345678)).toBe('₹1,23,456.78');
    expect(formatMoney(5)).toBe('₹0.05');
    expect(formatMoney(-150)).toBe('-₹1.50');
    expect(formatMoney(100, { symbol: false })).toBe('1.00');
  });

  it('parses input without floating point errors', () => {
    expect(parseMoney('1,234.5')).toBe(123450);
    expect(parseMoney('₹ 0.29')).toBe(29);
    expect(parseMoney('1.1')).toBe(110);
    expect(parseMoney('-12.05')).toBe(-1205);
    expect(parseMoney('.5')).toBe(50);
    expect(parseMoney('12')).toBe(1200);
  });

  it('rejects invalid input', () => {
    for (const bad of ['', 'abc', '1.234', '1.2.3', '.', null, undefined]) {
      expect(parseMoney(bad)).toBeNull();
    }
  });

  it('round-trips through input form', () => {
    expect(paiseToInput(12345)).toBe('123.45');
    expect(paiseToInput(12300)).toBe('123');
    expect(parseMoney(paiseToInput(123456789))).toBe(123456789);
  });
});

describe('quantity and rate', () => {
  it('formats and parses milli-units', () => {
    expect(formatQty(1250)).toBe('1.25');
    expect(formatQty(3000)).toBe('3');
    expect(formatQty(5)).toBe('0.005');
    expect(parseQty('1.25')).toBe(1250);
    expect(parseQty('0.005')).toBe(5);
    expect(parseQty('1.0005')).toBeNull();
  });

  it('formats basis points', () => {
    expect(formatRateBp(1800)).toBe('18%');
    expect(formatRateBp(250)).toBe('2.5%');
    expect(formatRateBp(0)).toBe('0%');
  });
});

describe('dates', () => {
  it('formats as dd-mm-yyyy', () => {
    expect(formatDate('2026-10-18')).toBe('18-10-2026');
    expect(formatDate('2026-10-18 11:42:05')).toBe('18-10-2026 11:42');
  });
});

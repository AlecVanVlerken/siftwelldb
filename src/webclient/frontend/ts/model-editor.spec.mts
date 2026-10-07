import { describe, expect, it } from 'vitest';
import { mergeScopedModel } from './model-editor.js';

describe('scoped schema model editing', () => {
  it('preserves other collections when saving the selected collection', () => {
    const current = {
      explores: [
        { collection: 'employees', label: 'Staff' },
        { collection: 'cities', label: 'Cities' },
      ],
    };
    const edited = { explores: [{ collection: 'employees', label: 'People' }] };
    expect(mergeScopedModel(edited, current, 'employees').explores).toEqual([
      { collection: 'cities', label: 'Cities' },
      { collection: 'employees', label: 'People' },
    ]);
    expect(current.explores[0]?.label).toBe('Staff');
  });

  it('rejects replacing a different collection through a scoped dialog', () => {
    expect(() => mergeScopedModel({ explores: [{ collection: 'cities' }] }, null, 'employees')).toThrow(
      'selected collection',
    );
  });

  it('keeps whole-database model editing available', () => {
    const edited = { explores: [{ collection: 'cities' }, { collection: 'employees' }] };
    expect(mergeScopedModel(edited, null, null)).toBe(edited);
  });
});

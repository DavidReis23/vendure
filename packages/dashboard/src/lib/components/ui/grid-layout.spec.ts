import { describe, expect, it } from 'vitest';

import {
    compactLayouts,
    findNextAvailablePosition,
    GridLayout,
    insertWithReflow,
    layoutsOverlap,
    reflowAroundAnchor,
} from './grid-layout.js';

const item = (i: string, x: number, y: number, w: number, h: number): GridLayout => ({ i, x, y, w, h });

/** Asserts that no two items in the layout occupy the same grid cells. */
function expectNoOverlaps(layouts: GridLayout[]) {
    for (let a = 0; a < layouts.length; a++) {
        for (let b = a + 1; b < layouts.length; b++) {
            expect(layoutsOverlap(layouts[a], layouts[b]), `${layouts[a].i} overlaps ${layouts[b].i}`).toBe(
                false,
            );
        }
    }
}

const byId = (layouts: GridLayout[], id: string): GridLayout => {
    const found = layouts.find(l => l.i === id);
    if (!found) {
        throw new Error(`No layout with id "${id}"`);
    }
    return found;
};

describe('layoutsOverlap', () => {
    it('detects overlapping items', () => {
        expect(layoutsOverlap(item('a', 0, 0, 4, 2), item('b', 2, 1, 4, 2))).toBe(true);
    });

    it('treats edge-adjacent items as non-overlapping', () => {
        expect(layoutsOverlap(item('a', 0, 0, 4, 2), item('b', 4, 0, 4, 2))).toBe(false);
        expect(layoutsOverlap(item('a', 0, 0, 4, 2), item('b', 0, 2, 4, 2))).toBe(false);
    });
});

describe('compactLayouts', () => {
    it('floats a lower widget up to fill the gap left above it', () => {
        const result = compactLayouts([item('a', 0, 0, 6, 2), item('b', 0, 5, 6, 2)]);
        expect(byId(result, 'a').y).toBe(0);
        expect(byId(result, 'b').y).toBe(2);
    });

    it('closes the gap left when a middle widget is removed', () => {
        // widgets originally stacked at y=0,2,4; the middle one (y=2) has been removed.
        const result = compactLayouts([item('a', 0, 0, 12, 2), item('c', 0, 4, 12, 2)]);
        expect(byId(result, 'a').y).toBe(0);
        expect(byId(result, 'c').y).toBe(2);
    });

    it('preserves horizontal position and compacts side-by-side widgets independently', () => {
        const result = compactLayouts([item('a', 0, 3, 6, 2), item('b', 6, 0, 6, 2)]);
        expect(byId(result, 'a')).toMatchObject({ x: 0, y: 0 });
        expect(byId(result, 'b')).toMatchObject({ x: 6, y: 0 });
    });

    it('preserves the input order regardless of position', () => {
        const result = compactLayouts([item('a', 0, 5, 6, 2), item('b', 0, 0, 6, 2)]);
        expect(result.map(l => l.i)).toEqual(['a', 'b']);
    });

    it('never produces overlaps', () => {
        const result = compactLayouts([item('a', 0, 4, 6, 2), item('b', 0, 0, 6, 2), item('c', 6, 0, 6, 3)]);
        expectNoOverlaps(result);
    });
});

describe('insertWithReflow', () => {
    it('keeps the inserted item at its saved position and pushes an overlapping widget down', () => {
        const result = insertWithReflow([item('a', 0, 0, 12, 2)], item('b', 0, 0, 12, 2));
        expect(byId(result, 'b')).toMatchObject({ x: 0, y: 0 });
        expect(byId(result, 'a').y).toBeGreaterThanOrEqual(2);
        expectNoOverlaps(result);
    });

    it('leaves other widgets untouched when the saved space is free', () => {
        const result = insertWithReflow([item('a', 0, 0, 6, 2)], item('b', 6, 0, 6, 2));
        expect(byId(result, 'a')).toMatchObject({ x: 0, y: 0 });
        expect(byId(result, 'b')).toMatchObject({ x: 6, y: 0 });
        expectNoOverlaps(result);
    });

    it('appends the inserted item so it is always present in the output', () => {
        const result = insertWithReflow([item('a', 0, 0, 6, 2)], item('b', 0, 0, 6, 2));
        expect(result).toHaveLength(2);
        expect(result.map(l => l.i)).toContain('b');
    });

    it('reflows multiple overlapping widgets without overlaps', () => {
        const result = insertWithReflow(
            [item('a', 0, 0, 6, 2), item('b', 6, 0, 6, 2)],
            item('c', 0, 0, 12, 2),
        );
        expect(byId(result, 'c')).toMatchObject({ x: 0, y: 0 });
        expectNoOverlaps(result);
    });
});

describe('reflowAroundAnchor', () => {
    it('keeps the anchor fixed and moves overlapping items out of the way', () => {
        const result = reflowAroundAnchor(
            [item('a', 0, 0, 12, 2), item('b', 0, 2, 12, 2)],
            item('b', 0, 0, 12, 2),
        );
        expect(byId(result, 'b')).toMatchObject({ x: 0, y: 0 });
        expectNoOverlaps(result);
    });
});

describe('findNextAvailablePosition', () => {
    it('finds a free slot to the side on the same row when available', () => {
        const pos = findNextAvailablePosition(
            item('a', 0, 0, 6, 2),
            [item('b', 0, 0, 6, 2)],
            item('b', 0, 0, 6, 2),
        );
        expect(pos).toMatchObject({ x: 6, y: 0 });
    });
});

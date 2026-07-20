import { describe, expect, it } from 'vitest';

import { Bm25Index, tokenize } from './bm25';

describe('tokenize', () => {
    it('lowercases, splits snake_case and punctuation, drops stopwords', () => {
        expect(tokenize('Refund_Order: give the money back!')).toEqual([
            'refund',
            'order',
            'give',
            'money',
            'back',
        ]);
    });

    it('returns empty for stopword-only text', () => {
        expect(tokenize('the of an in')).toEqual([]);
    });
});

describe('Bm25Index', () => {
    const index = new Bm25Index([
        { id: 'refund_order', text: 'refund order Refund a payment for an order.' },
        { id: 'list_orders', text: 'list orders List orders placed in the store.' },
    ]);

    it('scores 0 for a document containing no query term', () => {
        expect(index.score('list_orders', 'refund')).toBe(0);
    });

    it('weights rare terms above common ones', () => {
        // 'order(s)' appears in both docs, 'refund' only in one — refund_order must win.
        expect(index.score('refund_order', 'refund an order')).toBeGreaterThan(
            index.score('list_orders', 'refund an order'),
        );
    });
});

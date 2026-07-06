# OSS-274 Order Recalculation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make active orders reflect current pricing, promotions and shipping eligibility via an opt-in read-time recalculation strategy plus an always-on checkout-time recalc gate.

**Architecture:** Add a configurable `OrderRecalculationStrategy` (default no-op, one TTL built-in) invoked on the active-order read path through a new `OrderService.applyPriceAdjustmentsIfStale`, gated by a new nullable `Order.pricingUpdatedAt` timestamp bumped inside the single recalc entry point `applyPriceAdjustments`. Independently, the `AddingItems → ArrangingPayment` guard checks chosen shipping eligibility (read-only) then recalculates current prices.

**Tech Stack:** TypeScript, NestJS, TypeORM, Vendure core, GraphQL (SDL + codegen), vitest e2e via `@vendure/testing`.

## Global Constraints

- Package: `@vendure/core` (`packages/core`). Target branch: `master` (bug fix).
- **No migration files** — `packages/core` ships none. Entity change is schema-only; consumers regenerate. After the `Order` entity change, delete e2e seed caches: `rm -rf packages/core/e2e/__data__`.
- Backward compatible: default `orderRecalculationStrategy` = `NoOrderRecalculationStrategy` (read-time behavior unchanged unless opted in). Checkout gate is always-on (intended behavior change → changelog note).
- Strategy files follow the `changed-price-handling-strategy.ts` template; `extends InjectableStrategy` (import from `../../common/types/injectable-strategy`).
- New strategy exports added alphabetically to `packages/core/src/config/index.ts`.
- Commit messages: conventional, title only, no body, no co-author. Include `Fixes #3510` only in the final PR body (not commits), per repo convention this maps to OSS-274.
- Run TS build for `@vendure/core` after code changes; run affected e2e from `packages/core`.

---

### Task 1: OrderRecalculationStrategy interface + built-ins + exports

**Files:**
- Create: `packages/core/src/config/order/order-recalculation-strategy.ts`
- Create: `packages/core/src/config/order/no-order-recalculation-strategy.ts`
- Create: `packages/core/src/config/order/ttl-order-recalculation-strategy.ts`
- Modify: `packages/core/src/config/index.ts` (add 3 `export *` lines alphabetically)
- Test: `packages/core/src/config/order/ttl-order-recalculation-strategy.spec.ts`

**Interfaces:**
- Produces:
  - `interface OrderRecalculationStrategy extends InjectableStrategy { shouldRecalculate(ctx: RequestContext, order: Order): boolean | Promise<boolean>; }`
  - `class NoOrderRecalculationStrategy implements OrderRecalculationStrategy` — always `false`.
  - `class TtlOrderRecalculationStrategy implements OrderRecalculationStrategy` — ctor `({ ttlMs }: { ttlMs: number })`; stale when `order.pricingUpdatedAt == null || Date.now() - order.pricingUpdatedAt.getTime() >= ttlMs`.
- Consumes: `Order.pricingUpdatedAt` (added in Task 2 — the TTL strategy reads it; the field is optional `Date`, so TS compiles before Task 2 only if the property exists. Implement Task 1 and Task 2 together in that order, or stub the read as `(order as any).pricingUpdatedAt` is NOT allowed — instead sequence: do Task 2's entity column first if the compiler complains. See Step ordering note.)

> **Step ordering note:** `TtlOrderRecalculationStrategy` references `order.pricingUpdatedAt`. If you implement strictly task-by-task, add the entity column (Task 2, Step 1) before Task 1's TTL class so the type exists. The unit test in this task does not need the DB, only a plain object with a `pricingUpdatedAt` field.

- [ ] **Step 1: Write the failing unit test**

`packages/core/src/config/order/ttl-order-recalculation-strategy.spec.ts`
```ts
import { describe, expect, it } from 'vitest';

import { Order } from '../../entity/order/order.entity';

import { TtlOrderRecalculationStrategy } from './ttl-order-recalculation-strategy';

describe('TtlOrderRecalculationStrategy', () => {
    const ctx = {} as any;
    const strategy = new TtlOrderRecalculationStrategy({ ttlMs: 60_000 });

    function orderWith(pricingUpdatedAt: Date | undefined): Order {
        return { pricingUpdatedAt } as Order;
    }

    it('is stale when pricingUpdatedAt is null/undefined', () => {
        expect(strategy.shouldRecalculate(ctx, orderWith(undefined))).toBe(true);
    });

    it('is not stale within the TTL window', () => {
        expect(strategy.shouldRecalculate(ctx, orderWith(new Date(Date.now() - 1_000)))).toBe(false);
    });

    it('is stale past the TTL window', () => {
        expect(strategy.shouldRecalculate(ctx, orderWith(new Date(Date.now() - 120_000)))).toBe(true);
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/core && bunx vitest run src/config/order/ttl-order-recalculation-strategy.spec.ts`
Expected: FAIL — cannot find module `./ttl-order-recalculation-strategy`.

- [ ] **Step 3: Create the interface**

`packages/core/src/config/order/order-recalculation-strategy.ts`
```ts
import { RequestContext } from '../../api/common/request-context';
import { InjectableStrategy } from '../../common/types/injectable-strategy';
import { Order } from '../../entity/order/order.entity';

/**
 * @description
 * This strategy determines whether an active Order's prices, promotions, taxes and shipping
 * eligibility should be re-calculated when the Order is read (e.g. via the `activeOrder` query).
 * Recalculation is only ever attempted for Orders in the `AddingItems` state.
 *
 * The default {@link NoOrderRecalculationStrategy} never triggers a recalculation, preserving the
 * historical behaviour whereby an active Order's prices are only updated on write mutations. Use
 * {@link TtlOrderRecalculationStrategy} (or a custom implementation) to keep long-lived carts in
 * sync with changing product prices, promotions and shipping rules.
 *
 * :::info
 *
 * This is configured via the `orderOptions.orderRecalculationStrategy` property of your VendureConfig.
 *
 * :::
 *
 * @docsCategory orders
 * @since 3.8.0
 */
export interface OrderRecalculationStrategy extends InjectableStrategy {
    /**
     * @description
     * Return `true` to trigger a full recalculation of the Order before it is returned from the
     * active-order read path.
     */
    shouldRecalculate(ctx: RequestContext, order: Order): boolean | Promise<boolean>;
}
```

- [ ] **Step 4: Create the no-op default**

`packages/core/src/config/order/no-order-recalculation-strategy.ts`
```ts
import { RequestContext } from '../../api/common/request-context';
import { Order } from '../../entity/order/order.entity';

import { OrderRecalculationStrategy } from './order-recalculation-strategy';

/**
 * @description
 * The default {@link OrderRecalculationStrategy} which never triggers a read-time recalculation.
 * This preserves the behaviour of Vendure prior to v3.8.0, where an active Order's prices are only
 * re-calculated on write mutations.
 *
 * @docsCategory orders
 * @since 3.8.0
 */
export class NoOrderRecalculationStrategy implements OrderRecalculationStrategy {
    shouldRecalculate(): boolean {
        return false;
    }
}
```

- [ ] **Step 5: Create the TTL built-in**

`packages/core/src/config/order/ttl-order-recalculation-strategy.ts`
```ts
import { RequestContext } from '../../api/common/request-context';
import { Order } from '../../entity/order/order.entity';

import { OrderRecalculationStrategy } from './order-recalculation-strategy';

/**
 * @description
 * An {@link OrderRecalculationStrategy} which recalculates an active Order when the time since its
 * last recalculation exceeds the configured `ttlMs`. This mirrors the "price freeze period" model
 * used by other e-commerce platforms: quoted prices remain stable for a period, then refresh on the
 * next access.
 *
 * @example
 * ```ts
 * import { TtlOrderRecalculationStrategy, VendureConfig } from '@vendure/core';
 *
 * export const config: VendureConfig = {
 *   // ...
 *   orderOptions: {
 *     orderRecalculationStrategy: new TtlOrderRecalculationStrategy({ ttlMs: 5 * 60 * 1000 }),
 *   },
 * };
 * ```
 *
 * @docsCategory orders
 * @since 3.8.0
 */
export class TtlOrderRecalculationStrategy implements OrderRecalculationStrategy {
    constructor(private options: { ttlMs: number }) {}

    shouldRecalculate(ctx: RequestContext, order: Order): boolean {
        if (order.pricingUpdatedAt == null) {
            return true;
        }
        return Date.now() - order.pricingUpdatedAt.getTime() >= this.options.ttlMs;
    }
}
```

- [ ] **Step 6: Add exports**

In `packages/core/src/config/index.ts`, insert alphabetically among the `./order/*` lines:
```ts
export * from './order/default-order-recalculation-strategy';
```
Wait — the default is named `no-order-recalculation-strategy.ts`; add these three lines in alphabetical position:
```ts
export * from './order/no-order-recalculation-strategy';
export * from './order/order-recalculation-strategy';
export * from './order/ttl-order-recalculation-strategy';
```

- [ ] **Step 7: Run the unit test (green) — requires Task 2 Step 1 done for the `pricingUpdatedAt` type**

Run: `cd packages/core && bunx vitest run src/config/order/ttl-order-recalculation-strategy.spec.ts`
Expected: PASS (3 tests).

- [ ] **Step 8: Commit**

```bash
git add packages/core/src/config/order/order-recalculation-strategy.ts \
        packages/core/src/config/order/no-order-recalculation-strategy.ts \
        packages/core/src/config/order/ttl-order-recalculation-strategy.ts \
        packages/core/src/config/order/ttl-order-recalculation-strategy.spec.ts \
        packages/core/src/config/index.ts
git commit -m "feat(core): Add OrderRecalculationStrategy with TTL built-in"
```

---

### Task 2: `Order.pricingUpdatedAt` column + OrderOptions wiring

**Files:**
- Modify: `packages/core/src/entity/order/order.entity.ts` (add nullable column after `orderPlacedAt`, ~line 92)
- Modify: `packages/core/src/config/vendure-config.ts` (add `orderRecalculationStrategy?` to `OrderOptions`, before closing brace ~line 728)
- Modify: `packages/core/src/config/default-config.ts` (add to `orderOptions`, ~line 175-192)

**Interfaces:**
- Consumes: `OrderRecalculationStrategy`, `NoOrderRecalculationStrategy` (Task 1).
- Produces: `Order.pricingUpdatedAt?: Date`; `OrderOptions.orderRecalculationStrategy?: OrderRecalculationStrategy`.

- [ ] **Step 1: Add the entity column**

In `packages/core/src/entity/order/order.entity.ts`, after the `orderPlacedAt` column:
```ts
    /**
     * @description
     * The date & time that the Order's prices, promotions and shipping were last recalculated via
     * {@link OrderService.applyPriceAdjustments}. Used by the configured {@link OrderRecalculationStrategy}
     * to determine whether an active Order is stale and should be recalculated on read.
     *
     * @since 3.8.0
     */
    @Column({ nullable: true })
    pricingUpdatedAt?: Date;
```

- [ ] **Step 2: Add the OrderOptions member**

In `packages/core/src/config/vendure-config.ts`, add inside the `OrderOptions` interface (import `OrderRecalculationStrategy` at the top with the other order strategy imports):
```ts
    /**
     * @description
     * Defines whether and when an active Order's prices, promotions, taxes and shipping eligibility
     * are re-calculated when the Order is read (e.g. via the `activeOrder` query). By default no
     * read-time recalculation occurs (prices only change on write mutations). Use
     * {@link TtlOrderRecalculationStrategy} to keep long-lived carts in sync with changing prices,
     * promotions and shipping rules.
     *
     * @default NoOrderRecalculationStrategy
     * @since 3.8.0
     */
    orderRecalculationStrategy?: OrderRecalculationStrategy;
```

- [ ] **Step 3: Wire the default**

In `packages/core/src/config/default-config.ts`, add to the `orderOptions` object (and import `NoOrderRecalculationStrategy`):
```ts
        orderRecalculationStrategy: new NoOrderRecalculationStrategy(),
```

- [ ] **Step 4: Delete e2e seed caches (schema changed)**

Run: `rm -rf packages/core/e2e/__data__`
Expected: no output; caches will be regenerated on next e2e run.

- [ ] **Step 5: Build core to verify types**

Run: `cd packages/core && bunx tsc --noEmit -p tsconfig.json` (or the package's configured build)
Expected: no type errors.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/entity/order/order.entity.ts \
        packages/core/src/config/vendure-config.ts \
        packages/core/src/config/default-config.ts
git commit -m "feat(core): Add Order.pricingUpdatedAt and orderRecalculationStrategy option"
```

---

### Task 3: Recalc entry point — bump timestamp + `applyPriceAdjustmentsIfStale`

**Files:**
- Modify: `packages/core/src/service/services/order.service.ts` (in `applyPriceAdjustments` ~2306-2414; add new method after it)

**Interfaces:**
- Consumes: `configService.orderOptions.orderRecalculationStrategy`; `Order.pricingUpdatedAt`.
- Produces: `OrderService.applyPriceAdjustmentsIfStale(ctx: RequestContext, order: Order): Promise<Order>` — returns the (possibly recalculated) order.

- [ ] **Step 1: Bump `pricingUpdatedAt` inside `applyPriceAdjustments`**

In `applyPriceAdjustments`, immediately before the `Order` repository `.save(omit(updatedOrder, [...]))` call, set the timestamp on `updatedOrder`:
```ts
        updatedOrder.pricingUpdatedAt = new Date();
        // Explicitly omit the shippingAddress and billingAddress properties ... (existing save call follows)
```
(The `omit()` list only strips relations/customFields, not scalar columns, so `pricingUpdatedAt` persists.)

- [ ] **Step 2: Add `applyPriceAdjustmentsIfStale` method**

Add directly after `applyPriceAdjustments`:
```ts
    /**
     * @description
     * Recalculates the given active Order's prices, promotions, taxes and shipping if the configured
     * {@link OrderRecalculationStrategy} reports it as stale. Only Orders in the `AddingItems` state
     * are eligible. No-ops (returning the Order unchanged) otherwise. Invoked on the active-order
     * read path.
     *
     * @since 3.8.0
     */
    async applyPriceAdjustmentsIfStale(ctx: RequestContext, order: Order): Promise<Order> {
        if (!order.active || order.state !== 'AddingItems') {
            return order;
        }
        const { orderRecalculationStrategy } = this.configService.orderOptions;
        if (!orderRecalculationStrategy) {
            return order;
        }
        const stale = await orderRecalculationStrategy.shouldRecalculate(ctx, order);
        if (!stale) {
            return order;
        }
        // Ensure the relations needed for recalculation are loaded.
        const fullOrder = await this.getOrderOrThrow(ctx, order.id);
        return this.applyPriceAdjustments(ctx, fullOrder, fullOrder.lines);
    }
```

> Note: verify `getOrderOrThrow` loads `lines`, `shippingLines` and the variant relations that `applyPriceAdjustments` needs (it is used elsewhere for the same purpose). If it does not load `lines`/`shippingLines`, load via `this.findOne(ctx, order.id, ['lines', 'lines.productVariant', 'shippingLines'])` instead and assert found.

- [ ] **Step 3: Write the failing e2e test (stale recalc on read)**

Add to a new file `packages/core/e2e/order-recalculation.e2e-spec.ts`. Copy the setup boilerplate (imports, `createTestEnvironment`, `beforeAll`/`afterAll`, product seeding) **verbatim from `packages/core/e2e/order-changed-price-handling.e2e-spec.ts`**, then configure `orderOptions.orderRecalculationStrategy: new TtlOrderRecalculationStrategy({ ttlMs: 0 })` in the test config (ttl 0 = always stale, deterministic). Test body:
```ts
// #3510 — active order recalculates variant price change on read when strategy reports stale
it('recalculates changed variant price on read', async () => {
    await shopClient.asAnonymousUser();
    const { addItemToOrder } = await shopClient.query(ADD_ITEM_TO_ORDER, {
        productVariantId: 'T_1',
        quantity: 1,
    });
    orderResultGuard.assertSuccess(addItemToOrder);
    const originalTotal = addItemToOrder.totalWithTax;

    // Admin changes the variant price.
    await adminClient.query(UPDATE_PRODUCT_VARIANTS, {
        input: [{ id: 'T_1', price: originalTotal * 2 }],
    });

    // Reading the active order triggers a recalculation (ttlMs: 0 => always stale).
    const { activeOrder } = await shopClient.query(GET_ACTIVE_ORDER_WITH_PRICE_DATA);
    expect(activeOrder!.totalWithTax).not.toBe(originalTotal);
});
```
Use the existing `ADD_ITEM_TO_ORDER`, `UPDATE_PRODUCT_VARIANTS`, `GET_ACTIVE_ORDER_WITH_PRICE_DATA`/equivalent graphql docs already defined in the e2e graphql modules (see `order-changed-price-handling.e2e-spec.ts` imports for the exact names; reuse them).

- [ ] **Step 4: Run e2e to verify it fails (before wiring the read hook in Task 4)**

Run: `cd packages/core && bunx vitest run e2e/order-recalculation.e2e-spec.ts`
Expected: FAIL — active order still shows the original total (read hook not yet added).

- [ ] **Step 5: Commit (method only; test stays red until Task 4)**

```bash
git add packages/core/src/service/services/order.service.ts packages/core/e2e/order-recalculation.e2e-spec.ts
git commit -m "feat(core): Add applyPriceAdjustmentsIfStale and pricingUpdatedAt bump"
```

---

### Task 4: Read-time hook in `ActiveOrderService.getActiveOrder`

**Files:**
- Modify: `packages/core/src/service/helpers/active-order/active-order.service.ts` (`getActiveOrder`, ~74-131)

**Interfaces:**
- Consumes: `OrderService.applyPriceAdjustmentsIfStale` (Task 3). `this.orderService` is already injected.

- [ ] **Step 1: Invoke the hook before returning the order**

In `getActiveOrder`, replace the final `return order || undefined;` with a recalc-then-return:
```ts
        if (order) {
            order = await this.orderService.applyPriceAdjustmentsIfStale(ctx, order);
        }
        return order || undefined;
```
Rationale: single choke point for shop-API active-order reads; `applyPriceAdjustmentsIfStale` self-gates by state + strategy, so mutation paths (which just recalculated and refreshed `pricingUpdatedAt`) will not double-recalc under the TTL strategy.

- [ ] **Step 2: Run the Task 3 e2e test (now green)**

Run: `cd packages/core && bunx vitest run e2e/order-recalculation.e2e-spec.ts`
Expected: PASS — the price-change test now recalculates on read.

- [ ] **Step 3: Add a backward-compat e2e test (default no-op strategy)**

Add a second `describe` block in the same file configured with the **default** strategy (omit `orderRecalculationStrategy`, or set `new NoOrderRecalculationStrategy()`), asserting that after a variant price change the `activeOrder` total is UNCHANGED on read. Run it:
```ts
// #3510 — default strategy must not recalculate on read (backward compatibility)
it('does NOT recalculate on read with the default strategy', async () => {
    // ... add item, capture total, admin changes price ...
    const { activeOrder } = await shopClient.query(GET_ACTIVE_ORDER_WITH_PRICE_DATA);
    expect(activeOrder!.totalWithTax).toBe(originalTotal);
});
```
Run: `cd packages/core && bunx vitest run e2e/order-recalculation.e2e-spec.ts`
Expected: PASS (both suites).

- [ ] **Step 4: Add a promotion-staleness e2e test**

Add item to reach a promotion threshold, confirm the discount applies; admin deactivates/edits the promotion; read active order with the TTL(0) strategy; assert the discount is gone. Model the promotion setup on `packages/core/e2e/shop-order-promotions` tests (reuse `CREATE_PROMOTION`, `orderPercentageDiscount` action, etc.). Run and confirm PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/service/helpers/active-order/active-order.service.ts packages/core/e2e/order-recalculation.e2e-spec.ts
git commit -m "feat(core): Recalculate stale active order on read"
```

---

### Task 5: Checkout gate — shipping eligibility check + recalc

**Files:**
- Modify: `packages/core/src/config/order/default-order-process.ts` (`init` ~237-259; `onTransitionStart` ArrangingPayment branch ~317-352)
- Modify: `packages/core/src/i18n/messages/en.json` (add message key near line 124)

**Interfaces:**
- Consumes: `OrderService.getEligibleShippingMethods(ctx, orderId): Promise<ShippingMethodQuote[]>`, `OrderService.applyPriceAdjustments`. `idsAreEqual` from `../../common/utils`.

- [ ] **Step 1: Add the i18n message key**

In `packages/core/src/i18n/messages/en.json`, after `"cannot-transition-to-payment-without-shipping-method"`:
```json
    "cannot-transition-to-payment-with-ineligible-shipping-method": "Cannot transition Order to the \"ArrangingPayment\" state because the selected ShippingMethod is no longer eligible",
```

- [ ] **Step 2: Lazily inject OrderService in `init`**

In `default-order-process.ts`, add a closure variable `let orderService: import('../../service/services/order.service').OrderService;` near the other service closures, and in `init`:
```ts
            const OrderService = await import('../../service/index.js').then(m => m.OrderService);
            // ... after the other injector.get calls:
            orderService = injector.get(OrderService);
```
> Watch circular-deps: `OrderService` is a large service used across DefaultConfig; the lazy dynamic import (matching the existing pattern for `StockMovementService` etc.) is what avoids the cycle. If a cycle still manifests at bootstrap, fall back to `injector.get(OrderService)` without the static import type and type `orderService` as `any` locally (last resort — prefer the typed import).

- [ ] **Step 3: Write the failing e2e test (ineligible shipping refuses checkout)**

In `order-recalculation.e2e-spec.ts` (TTL suite), add: create an order, set a shipping method that is eligible only under a condition (e.g. min order total) that the order currently meets; then reduce the order (remove an item) OR change the shipping method's eligibility checker via admin so the chosen method becomes ineligible; attempt `transitionOrderToState('ArrangingPayment')`; assert an `OrderStateTransitionError` whose `transitionError` contains "no longer eligible", and that the order is still `AddingItems`.
```ts
// #3510 — checkout refused when chosen shipping method became ineligible
it('refuses ArrangingPayment when chosen shipping method is ineligible', async () => {
    // ... set up order + eligible shipping method, then make it ineligible ...
    const { transitionOrderToState } = await shopClient.query(TRANSITION_TO_STATE, {
        state: 'ArrangingPayment',
    });
    orderResultGuard.assertErrorResult(transitionOrderToState);
    expect(transitionOrderToState.errorCode).toBe(ErrorCode.ORDER_STATE_TRANSITION_ERROR);
    expect((transitionOrderToState as any).transitionError).toContain('no longer eligible');
});
```

- [ ] **Step 4: Run e2e to verify it fails**

Run: `cd packages/core && bunx vitest run e2e/order-recalculation.e2e-spec.ts`
Expected: FAIL — transition currently succeeds (no eligibility check yet).

- [ ] **Step 5: Implement the checkout gate**

In `onTransitionStart`, inside the `if (toState === 'ArrangingPayment') { ... }` block, **after** the existing `arrangingPaymentRequiresShipping` check and **before/independent of** the stock check, add:
```ts
                if (
                    options.arrangingPaymentRequiresShipping !== false &&
                    order.shippingLines?.length
                ) {
                    const eligibleMethods = await orderService.getEligibleShippingMethods(ctx, order.id);
                    const eligibleIds = eligibleMethods.map(m => m.id);
                    const hasIneligible = order.shippingLines.some(
                        line =>
                            line.shippingMethodId != null &&
                            !eligibleIds.some(id => idsAreEqual(id, line.shippingMethodId)),
                    );
                    if (hasIneligible) {
                        return 'message.cannot-transition-to-payment-with-ineligible-shipping-method';
                    }
                    // All chosen shipping methods are still eligible: refresh prices, promotions and
                    // taxes to current values before payment. No shipping swap can occur here.
                    await orderService.applyPriceAdjustments(ctx, order, order.lines);
                }
```
Add the import if missing: `import { idsAreEqual } from '../../common/utils';`.

- [ ] **Step 6: Run e2e to verify green**

Run: `cd packages/core && bunx vitest run e2e/order-recalculation.e2e-spec.ts`
Expected: PASS.

- [ ] **Step 7: Add a happy-path checkout recalc test**

Add: order with an eligible shipping method and an active promotion; admin changes a variant price; `transitionOrderToState('ArrangingPayment')` succeeds and the resulting order reflects the new price (assert `totalWithTax` changed vs. pre-transition). Run and confirm PASS.

- [ ] **Step 8: Full affected e2e + build**

Run: `cd packages/core && bunx vitest run e2e/order.e2e-spec.ts e2e/order-changed-price-handling.e2e-spec.ts e2e/shop-order.e2e-spec.ts e2e/order-recalculation.e2e-spec.ts`
Expected: PASS (guards against regressions in the checkout/transition paths).
Run: core TS build — no errors.

- [ ] **Step 9: Commit**

```bash
git add packages/core/src/config/order/default-order-process.ts \
        packages/core/src/i18n/messages/en.json \
        packages/core/e2e/order-recalculation.e2e-spec.ts
git commit -m "feat(core): Recalculate and verify shipping eligibility at checkout"
```

---

### Task 6: Docs generation + changelog note

**Files:**
- Modify: generated docs / API reference if the repo has a docs-gen step for config strategies (run it; do not hand-write).

- [ ] **Step 1: Regenerate typegen/docs if required**

Run the repo's codegen/docs generation for new config strategies (check `package.json` scripts, e.g. `bun run codegen` at root or `docs:build`). Only commit generated artifacts the repo tracks.

- [ ] **Step 2: Add changelog / behavior-change note**

Note the always-on checkout eligibility gate as an intended behavior change in the PR description (not a source changelog file unless the repo tracks one for core).

- [ ] **Step 3: Commit any generated files**

```bash
git commit -am "docs(core): Regenerate reference for orderRecalculationStrategy"
```

---

## Self-Review

**Spec coverage:**
- Read-time strategy (interface + no-op + TTL) → Task 1. ✔
- `Order.pricingUpdatedAt` + OrderOptions wiring → Task 2. ✔
- Timestamp bump in single entry point → Task 3 Step 1. ✔
- Read-time hook at choke point → Task 4. ✔
- Checkout gate (check-then-recalc) + refusal via OrderStateTransitionError → Task 5. ✔
- Backward-compat (default no-op) test → Task 4 Step 3. ✔
- No migration file / delete e2e caches → Global Constraints + Task 2 Step 4. ✔
- Out of scope (version-counter, OSS-94, payment-time) → not planned, correct. ✔

**Placeholder scan:** Production code blocks are complete. E2e test bodies reference reuse of existing graphql docs (`ADD_ITEM_TO_ORDER`, `UPDATE_PRODUCT_VARIANTS`, `CREATE_PROMOTION`, `TRANSITION_TO_STATE`) from the established core e2e graphql modules rather than re-declaring them — implementer must import the exact names from the same modules `order-changed-price-handling.e2e-spec.ts` uses. This is deliberate (DRY with existing harness), not a placeholder.

**Type consistency:** `applyPriceAdjustmentsIfStale(ctx, order)` defined Task 3, consumed Task 4. `shouldRecalculate(ctx, order)` defined Task 1, consumed Task 3. `pricingUpdatedAt?: Date` defined Task 2, read in Task 1 (TTL) and Task 3. `getEligibleShippingMethods(ctx, orderId): ShippingMethodQuote[]` (existing) consumed Task 5. Names consistent.

**Known risk to watch during execution:** e2e graphql doc names differ slightly between suites — the implementer must confirm the exact exported symbol names when importing. Circular-dependency at Task 5 Step 2 (OrderService in DefaultConfig) is the highest-risk step; the lazy-import pattern is the mitigation, with a documented fallback.

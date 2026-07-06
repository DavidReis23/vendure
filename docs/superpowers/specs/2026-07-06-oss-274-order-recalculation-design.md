# OSS-274 — Dynamic Order Recalculation (pricing, promotions, shipping eligibility)

Date: 2026-07-06
Issue: [OSS-274](https://linear.app/vendure/issue/OSS-274) (GitHub #3510)
Related (separate work): [OSS-94](https://linear.app/vendure/issue/OSS-94) stock oversell — out of scope here.

## Problem

Order pricing in core is **purely mutation-driven**. `OrderService.applyPriceAdjustments`
(`packages/core/src/service/services/order.service.ts`) fully re-tests promotions, shipping
eligibility and prices, but only runs on write mutations (`addItemsToOrder`, `adjustOrderLines`,
`applyCouponCode`, `setShippingMethod`, address/surcharge/currency mutations, …). A cart untouched
since an underlying change displays and can check out with stale data.

Verified gaps (current code):

1. **View time** — `activeOrder` resolver (`api/resolvers/shop/shop-order.resolver.ts`) does a plain
   `findOne`. `ActiveOrderService.getActiveOrder` has no pricing logic. Stale totals persist
   indefinitely.
2. **Checkout time** — `AddingItems → ArrangingPayment` guard
   (`config/order/default-order-process.ts`, `onTransitionStart`) checks only: lines non-empty,
   customer set, shipping line **exists** (not eligible), saleable stock, variants exist. No price
   recalc, no promotion re-test, no shipping **eligibility** re-test.
3. **Payment time** — `addPaymentToOrder` revalidates coupon-code promotions only
   (`revalidateCouponCodesForOrder`). Auto-applied promotions, variant price changes and shipping
   eligibility are not re-checked. (Partially mitigated by `CouponRemovedDuringCheckoutError`, PR
   #4660, which refuses if a coupon strip raises the total.)

## Scope

**In scope**

- A configurable **read-time** recalculation strategy on `OrderOptions`, defaulting to current
  behavior (no recalculation) for backward compatibility.
- One shipped built-in strategy: **TTL** (Saleor "price-freeze period" model).
- A **checkout gate**: recalc on `→ ArrangingPayment`, refusing the transition with a typed error
  when the customer's chosen shipping method has become ineligible.

**Explicitly out of scope** (decided, to avoid scope creep)

- Version-counter strategy. Rejected for now: blind to time-based promotion eligibility
  (`startsAt`/`endsAt` fire no event), channel-wide thundering-herd on read, and large core surface
  (per-channel counter store + `ProductVariant`/`Promotion`/`ShippingMethod` listeners + `Order`
  column). The strategy interface leaves the door open to add it later without a breaking change.
- OSS-94 stock oversell (TOCTOU) — separate branch/PR.
- Payment-time recalc beyond the existing coupon revalidation.

## Design

### 1. `OrderRecalculationStrategy` (new)

`packages/core/src/config/order/order-recalculation-strategy.ts`

```ts
export interface OrderRecalculationStrategy extends InjectableStrategy {
    /**
     * Called on the active-order read path. Return true to trigger a full
     * price/promotion/shipping recalculation of the order before it is returned.
     * Only invoked for orders in a mutable state ('AddingItems').
     */
    shouldRecalculate(ctx: RequestContext, order: Order): boolean | Promise<boolean>;
}
```

- Default built-in: `NoOrderRecalculationStrategy` — always returns `false` (current behavior).
- Wired at `orderOptions.orderRecalculationStrategy` in `VendureConfig`
  (`config/vendure-config.ts`), default set in `config/default-config.ts`.

### 2. `TtlOrderRecalculationStrategy` (TTL built-in)

`packages/core/src/config/order/ttl-order-recalculation-strategy.ts`

```ts
new TtlOrderRecalculationStrategy({ ttlMs: 5 * 60 * 1000 })
```

`shouldRecalculate` returns `true` when `now - order.pricingUpdatedAt >= ttlMs` (or
`pricingUpdatedAt` is null). Uses request time; no events, no background jobs.

### 3. `Order.pricingUpdatedAt` column (new, nullable)

- New nullable `Date` column on the `Order` entity. **No migration file** — `packages/core` ships
  no migrations; consumers regenerate via `generateMigration`. E2E seed caches
  (`packages/core/e2e/__data__/`) must be deleted so the schema is re-synced.
- Set to the current time inside `OrderService.applyPriceAdjustments` (the single recalc entry
  point) so every recalc — mutation-driven or read-time — refreshes it.
- Rationale: cannot reuse `Order.updatedAt`, which bumps on unrelated saves (address, custom
  fields) and would mask staleness.

### 4. Read-time hook

- New method `OrderService.applyPriceAdjustmentsIfStale(ctx, order)`: loads required relations
  (`lines`, `shippingLines`, promotions) if absent, checks
  `order.active && order.state === 'AddingItems'`, calls
  `orderOptions.orderRecalculationStrategy.shouldRecalculate`, and if `true` runs
  `applyPriceAdjustments(ctx, order, order.lines)` (all lines passed so variant price changes are
  picked up). No-ops otherwise.
- Invoked from `ActiveOrderService.getActiveOrder`
  (`service/helpers/active-order/active-order.service.ts`) — the single choke point for shop-API
  active-order reads. `ActiveOrderService` already injects `OrderService`, so no new circular
  dependency.
- Gating by state means an order just mutated (freshly recalculated, `pricingUpdatedAt` current)
  will not be recalculated again on the immediately following read.

### 5. Checkout gate

In `default-order-process.ts` `onTransitionStart`, for `toState === 'ArrangingPayment'`, added
after the existing shipping-line-exists check — **check-then-recalc** order:

1. **Eligibility check (read-only, no writes).** Call
   `orderService.getEligibleShippingMethods(ctx, order.id)` and verify every
   `order.shippingLines[].shippingMethodId` is in the eligible set. If any chosen method is no
   longer eligible → **refuse** the transition by returning the translation key
   `message.cannot-transition-to-payment-with-ineligible-shipping-method`. No recalc has run, so
   nothing is persisted.
2. **Recalc (only once eligibility passes).** Call `orderService.applyPriceAdjustments(ctx, order,
   order.lines)` to refresh prices, taxes and promotions to current values. Because every chosen
   shipping method is already eligible, `OrderCalculator` performs no shipping swap; the persisted
   changes are the desired current-price adjustments.

`OrderService` is obtained in the process's `init(injector)` via the existing lazy-import pattern
(mirrors `productVariantService`, `stockLevelService`, …), avoiding the DefaultConfig circular
dependency.

**Why check-then-recalc and not recalc-then-check:** `transitionToState` catches a guard failure
and *returns* `OrderStateTransitionError` from inside `withTransaction` (it does not re-throw), so
the transaction **commits**. Recalculating first and then refusing would persist the recalc
(including any shipping swap) while returning an error — an inconsistent state. Checking first
guarantees nothing is written on refusal.

### Error handling

Refusal surfaces through the **existing** `OrderStateTransitionError` mechanism: the guard returns a
translation-key string which `transitionToState` wraps into
`OrderStateTransitionError.transitionError`. This matches how every other `ArrangingPayment` guard
already reports failure (empty order, no customer, no shipping line, insufficient stock).

- **No new typed GraphQL error / no codegen.** A dedicated `ShippingMethodIneligibleError` was
  considered but rejected: the order-process guard API can only return strings (typed
  `ErrorResult`s would require moving the recalc out of the process into `OrderService` plus a
  schema + codegen change), and it would be inconsistent with the sibling checkout guards. Same
  user-facing outcome (transition refused, descriptive message), less surface area.
- We deliberately do **not** silently swap to the cheapest eligible method (rejected: violates the
  ticket's "notify the customer immediately" requirement, inconsistent with the coupon precedent,
  and can charge a higher amount without consent).
- A new translation key `message.cannot-transition-to-payment-with-ineligible-shipping-method` is
  added to the i18n message files alongside the existing
  `message.cannot-transition-to-payment-*` keys.

### Backward compatibility

- Default `orderRecalculationStrategy` = `NoOrderRecalculationStrategy` → read-time behavior
  unchanged unless opted in.
- The checkout gate is **always on**. This changes behavior: a checkout with a since-invalidated
  shipping method now errors instead of proceeding. This is the intended revenue-protection fix and
  must be called out in the changelog / migration notes. (Open question O2: should the checkout
  gate itself be feature-flaggable? Current recommendation: no — it is the core fix.)
- New nullable column → additive schema change, no data backfill required (`null` treated as
  stale). Consumers pick it up via their own generated migration.

## Data flow

```
Shop reads activeOrder
  → ActiveOrderService.getActiveOrder
    → OrderService.applyPriceAdjustmentsIfStale
      → strategy.shouldRecalculate? (state=AddingItems only)
        → yes: applyPriceAdjustments(order, order.lines) → bumps pricingUpdatedAt, saves
        → no:  return as-is

Shop transitionToState → ArrangingPayment
  → default-order-process onTransitionStart
    → getEligibleShippingMethods; chosen method ineligible?
        → yes: return 'message.cannot-transition-to-payment-with-ineligible-shipping-method'
               → OrderStateTransitionError (nothing persisted)
        → no:  applyPriceAdjustments(order, order.lines)  [refresh current prices/promos]
               → proceed
```

## Testing

- **e2e** (`packages/core/e2e/`): stale-cart-recalculation suite —
  - promotion deactivated / threshold changed after add → read-time recalc drops it (TTL elapsed).
  - variant price changed after add → read-time recalc adopts new price.
  - shipping method made ineligible after add → checkout returns `OrderStateTransitionError` whose
    `transitionError` is the ineligible-shipping message; order NOT transitioned, no recalc persisted.
  - default (no-op strategy) → totals unchanged on read (backward-compat guard).
  - checkout with still-eligible everything → transitions normally.
- **unit**: `TtlOrderRecalculationStrategy.shouldRecalculate` boundary (null / within TTL / past
  TTL); `applyPriceAdjustmentsIfStale` state gating.

## Open questions

- **O2** — Should the always-on checkout gate be feature-flaggable? Recommendation: no — it is the
  core revenue-protection fix; a flag re-opens the hole.

## Follow-ups (not this PR)

- OSS-94 stock oversell (own branch `mgrolmus/oss-94-…`).
- Optional `VersionCounterOrderRecalculationStrategy` if demand arises.

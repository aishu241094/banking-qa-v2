import { test, expect } from '../fixtures';
import QuickPayPage from '../../pages/QuickPayPage';

/**
 * Locator-healing demo. The page object looks for '#pay-now-btn', but the
 * front-end team has since replaced that button with one that has no id. The
 * test fails, the fixture captures the DOM, and `npm start -- --test heal-demo`
 * queues a suggested locator for `npm run heal:review`. Approving it rewrites
 * pages/QuickPayPage.ts and the test passes.
 */
const QUICK_PAY_HTML = `
<main>
  <h1>Quick pay</h1>
  <form onsubmit="event.preventDefault(); document.getElementById('result').textContent = 'Payment of £' + document.getElementById('amt').value + ' sent';">
    <label for="amt">Amount</label>
    <input id="amt" name="amount" type="number" />
    <button type="submit" class="btn btn-primary" data-testid="quick-pay-submit">Pay now</button>
    <button type="button" class="btn btn-link">Cancel</button>
  </form>
  <p id="result" role="status"></p>
</main>`;

test('quick pay sends a payment under the IMPS limit @heal-demo', async ({ page }) => {
  await page.setContent(QUICK_PAY_HTML);
  const quickPay = new QuickPayPage(page);

  await quickPay.pay('250');

  await expect(quickPay.confirmation).toHaveText('Payment of £250 sent');
});

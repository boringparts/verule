// @ts-nocheck
function unmodeledHandler(req) {
  if (req.length > 0) {
    // oxlint-disable-next-line eslint/no-with
    with ({}) {
    }
  } else if (hasApiKey(req)) {
    verifyApiKey(req);
  } else {
    return;
  }
  runAction(req);
}
module.exports = { unmodeledHandler };

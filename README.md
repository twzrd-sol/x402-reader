# x402-reader

Paid GET that turns an ordinary URL into markdown.

`GET /scrape?url=` → HTTP 402 ($0.005 USDC, Solana + Base) → markdown.

This is the standalone seller export for https://reader.outbid.sh (no private
buyer or ops history). Its x402 v2 challenge includes Coinbase Bazaar input and
output metadata under the service name `x402 Reader`. Coinbase's production
facilitator requires `COINBASE_API_KEY` and `COINBASE_API_KEY_SECRET`.

bind-v1 review (leaf, memo, TransferChecked): https://github.com/twzrd-sol/twzrd-trust/blob/main/REVIEW.md

# Mainnet Deployment Checklist

## Before going to mainnet

- [ ] Change NETWORK=mainnet in .env
- [ ] Change BASE_URL to production URL
- [ ] Get real USDC from Circle (issuer: GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN)
- [ ] Create trustlines with official Circle USDC issuer
- [ ] Fund provider and agent wallets with real USDC
- [ ] Re-deploy Soroban contract on mainnet
- [ ] Implement txHash persistence (Redis or PostgreSQL) 
      to prevent replay attacks across server restarts
- [ ] Add rate limiting per wallet address
- [ ] Set up monitoring and alerts
- [ ] Audit invokeReputationContract error handling
- [ ] Remove USDC_ISSUER_SECRET from environment 
      (not needed after initial setup)

## Security checklist

- [ ] Secret keys stored in environment variables only
- [ ] .env never committed to git
- [ ] txHash replay protection active
- [ ] Transaction timestamp validation active (5 min window)
- [ ] All endpoints return proper error codes

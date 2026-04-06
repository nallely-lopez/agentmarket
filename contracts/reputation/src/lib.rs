#![no_std]

use soroban_sdk::{contract, contractimpl, symbol_short, Address, Env, Symbol};

// Storage keys
const TOTAL_PAYMENTS_KEY: Symbol = symbol_short!("TOTAL_PAY");

#[contract]
pub struct ReputationContract;

#[contractimpl]
impl ReputationContract {
    /// Records a payment for a service, accumulating its reputation score.
    /// service_id: identifier of the service (e.g. "translate", "price")
    /// buyer:      the Address that made the payment
    /// amount:     payment amount in stroops (i128)
    pub fn record_payment(env: Env, service_id: Symbol, _buyer: Address, amount: i128) {
        // Accumulate score for this service_id
        let current_score: i128 = env
            .storage()
            .persistent()
            .get(&service_id)
            .unwrap_or(0i128);
        env.storage()
            .persistent()
            .set(&service_id, &(current_score + amount));

        // Increment global payment counter
        let total: u32 = env
            .storage()
            .persistent()
            .get(&TOTAL_PAYMENTS_KEY)
            .unwrap_or(0u32);
        env.storage()
            .persistent()
            .set(&TOTAL_PAYMENTS_KEY, &(total + 1));
    }

    /// Returns the accumulated reputation score for a service (0 if unknown).
    pub fn get_score(env: Env, service_id: Symbol) -> i128 {
        env.storage()
            .persistent()
            .get(&service_id)
            .unwrap_or(0i128)
    }

    /// Returns the total number of payments recorded across all services.
    pub fn get_total_payments(env: Env) -> u32 {
        env.storage()
            .persistent()
            .get(&TOTAL_PAYMENTS_KEY)
            .unwrap_or(0u32)
    }
}

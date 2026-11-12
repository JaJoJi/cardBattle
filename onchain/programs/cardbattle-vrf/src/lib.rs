//! RitArena Card Battle — per-arena MagicBlock VRF randomness.
//!
//! For every staked RitArena arena, the house (game server / oracle) calls
//! `request_match_randomness` with a commitment `sha256(private_entropy || match_id)`.
//! The commitment is stored on-chain and used as the VRF `caller_seed` in the SAME
//! transaction, so the house is bound to its private entropy before the VRF output
//! exists. MagicBlock's oracle then calls `consume_match_randomness` (authenticated by
//! the scoped VRF identity via `#[vrf_callback]`) to store the verified 32-byte output.
//!
//! The game server derives each match's shuffle seed from BOTH values off-chain:
//!   master = sha256("RITARENA_SEED_V2" || private_entropy || vrf_randomness || match_id)
//! Deck order stays private (private_entropy is secret until the match ends), the house
//! cannot grind (commitment precedes randomness), and anyone can verify afterwards from
//! the revealed entropy plus this account.
//!
//! This program holds no funds and does not touch the RitArena program.

use anchor_lang::prelude::*;
use ephemeral_rollups_sdk::anchor::{vrf, vrf_callback};
use ephemeral_rollups_sdk::vrf::{
    self,
    instructions::{create_request_randomness_ix, RequestRandomnessParams},
    types::SerializableAccountMeta,
};

declare_id!("11111111111111111111111111111111");

pub const MATCH_RNG_SEED: &[u8] = b"match_rng";

#[program]
pub mod cardbattle_vrf {
    use super::*;

    /// Creates the per-arena randomness account, records the house's commitment and
    /// requests VRF randomness seeded with that commitment. One request per (house, arena).
    pub fn request_match_randomness(ctx: Context<RequestMatchRandomness>, arena_id: u64, commitment: [u8; 32]) -> Result<()> {
        require!(commitment != [0u8; 32], CardBattleVrfError::EmptyCommitment);
        let match_rng_key = ctx.accounts.match_rng.key();
        {
            let rng = &mut ctx.accounts.match_rng;
            rng.authority = ctx.accounts.payer.key();
            rng.arena_id = arena_id;
            rng.commitment = commitment;
            rng.randomness = [0u8; 32];
            rng.fulfilled = false;
            rng.requested_slot = Clock::get()?.slot;
            rng.fulfilled_slot = 0;
            rng.bump = ctx.bumps.match_rng;
        }

        let ix = create_request_randomness_ix(RequestRandomnessParams {
            payer: ctx.accounts.payer.key(),
            oracle_queue: ctx.accounts.oracle_queue.key(),
            callback_program_id: ID,
            callback_discriminator: instruction::ConsumeMatchRandomness::DISCRIMINATOR.to_vec(),
            // Binds the VRF request to the house's commitment.
            caller_seed: commitment,
            accounts_metas: Some(vec![SerializableAccountMeta {
                pubkey: match_rng_key,
                is_signer: false,
                is_writable: true,
            }]),
            ..Default::default()
        });
        ctx.accounts.invoke_signed_vrf(&ctx.accounts.payer.to_account_info(), &ix)?;
        emit!(RandomnessRequested { arena_id, authority: ctx.accounts.payer.key(), commitment });
        Ok(())
    }

    /// VRF callback: only MagicBlock's VRF program (scoped identity for this program) can call it.
    pub fn consume_match_randomness(ctx: Context<ConsumeMatchRandomness>, randomness: [u8; 32]) -> Result<()> {
        let rng = &mut ctx.accounts.match_rng;
        require!(!rng.fulfilled, CardBattleVrfError::AlreadyFulfilled);
        rng.randomness = randomness;
        rng.fulfilled = true;
        rng.fulfilled_slot = Clock::get()?.slot;
        emit!(RandomnessFulfilled { arena_id: rng.arena_id, authority: rng.authority, randomness });
        Ok(())
    }
}

#[vrf]
#[derive(Accounts)]
#[instruction(arena_id: u64)]
pub struct RequestMatchRandomness<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(
        init,
        payer = payer,
        space = 8 + MatchRandomness::INIT_SPACE,
        seeds = [MATCH_RNG_SEED, payer.key().as_ref(), &arena_id.to_le_bytes()],
        bump,
    )]
    pub match_rng: Account<'info, MatchRandomness>,
    /// CHECK: MagicBlock VRF oracle queue (base layer on devnet/mainnet, test queue on localnet).
    #[account(
        mut,
        constraint = oracle_queue.key() == vrf::consts::DEFAULT_QUEUE
            || oracle_queue.key() == vrf::consts::DEFAULT_TEST_QUEUE
            @ CardBattleVrfError::InvalidQueue
    )]
    pub oracle_queue: UncheckedAccount<'info>,
}

#[vrf_callback]
#[derive(Accounts)]
pub struct ConsumeMatchRandomness<'info> {
    #[account(mut)]
    pub match_rng: Account<'info, MatchRandomness>,
}

#[account]
#[derive(InitSpace)]
pub struct MatchRandomness {
    /// House / oracle wallet that requested (and committed).
    pub authority: Pubkey,
    /// RitArena arena id this randomness belongs to.
    pub arena_id: u64,
    /// sha256(private_entropy || match_id), fixed before the VRF output existed.
    pub commitment: [u8; 32],
    /// Verified VRF output (zero until fulfilled).
    pub randomness: [u8; 32],
    pub fulfilled: bool,
    pub requested_slot: u64,
    pub fulfilled_slot: u64,
    pub bump: u8,
}

#[event]
pub struct RandomnessRequested {
    pub arena_id: u64,
    pub authority: Pubkey,
    pub commitment: [u8; 32],
}

#[event]
pub struct RandomnessFulfilled {
    pub arena_id: u64,
    pub authority: Pubkey,
    pub randomness: [u8; 32],
}

#[error_code]
pub enum CardBattleVrfError {
    #[msg("Randomness for this arena was already delivered")]
    AlreadyFulfilled,
    #[msg("Commitment must not be empty")]
    EmptyCommitment,
    #[msg("Unsupported VRF oracle queue")]
    InvalidQueue,
}

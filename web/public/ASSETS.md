# Art placeholders

Drop images here with these exact names. Anything missing falls back to a styled
placeholder automatically. Recommended format: PNG/WebP (rename the extension in
`src/assets.ts` if you use WebP).

| Path | Used for | Suggested size |
| --- | --- | --- |
| `cards/<card-id>.png` | Card art (top half of the card) | 400×290 (≈ 1.38:1) |
| `cards/back.png` | Card back | 300×420 (5:7) |
| `avatars/player.png` | Player portrait | 256×256 |
| `avatars/ai.png` | AI portrait | 256×256 |
| `vault/emblem.png` | Vault page emblem | 256×256 |

Card ids (30):
- Attack: quick_strike, heavy_strike, shield_bash, piercing_arrow, venom_strike, cleave,
  rending_claw, draining_bite, crushing_blow, phantom_lance, guillotine, meteor_impact
- Defense: basic_shield, bandage, fortify, tactical_retreat, arcane_barrier, second_wind,
  iron_skin, mirror_shield, divine_protection
- Spell: arcane_insight, toxic_cloud, regeneration, unstoppable, lifesteal, arcane_bolt,
  disruption, reflection, fireball

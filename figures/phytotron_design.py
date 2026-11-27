import random
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.patches import FancyBboxPatch, Rectangle, Circle, Polygon, Ellipse

plt.rcParams["font.family"] = "DejaVu Serif"
INK = "#1f2933"
TEMP = {15: "#dce8f5", 25: "#e2f0dc", 35: "#fae3d6"}
TEMP_EDGE = {15: "#7a9cc6", 25: "#7fae6e", 35: "#d9906a"}
MOIST = {30: "#e8b14a", 60: "#5a9a45", 90: "#3a78a8"}

fig = plt.figure(figsize=(10, 13.2), dpi=200)
ax = fig.add_axes([0, 0, 1, 1])
ax.set_xlim(0, 100)
ax.set_ylim(0, 132)
ax.axis("off")


def box(x, y, w, h, fc, ec=INK, lw=1.0, ls="-", r=0.8, z=1):
    p = FancyBboxPatch((x, y), w, h, boxstyle=f"round,pad=0,rounding_size={r}",
                       fc=fc, ec=ec, lw=lw, ls=ls, zorder=z)
    ax.add_patch(p)
    return p


def t(x, y, s, size=8, **kw):
    kw.setdefault("ha", "center")
    kw.setdefault("va", "center")
    kw.setdefault("color", INK)
    ax.text(x, y, s, fontsize=size, **kw)


# ---------------- (a) phytotron ----------------
t(2, 129.5, "(a) Growth phytotron allocation per run: temperature (phytotron) × photoperiod (compartment)",
  10.5, ha="left", weight="bold")

photos = [("10L:14D", "short day"), ("12L:12D", "near-critical"), ("14L:10D", "long day")]
cw, ch_top, ch_bot = 29.5, 125, 74
xs = [3, 35.25, 67.5]
temps = [15, 25, 35]
for i, x in enumerate(xs):
    if i < 3:
        T = temps[i]
        box(x, ch_bot, cw, ch_top - ch_bot, "#f7f8fa", ec=INK, lw=1.4)
        t(x + cw / 2, ch_top - 2.6, f"Growth phytotron {i + 1}", 9, weight="bold")
        t(x + cw / 2, ch_top - 5.4, f"{T} °C  ·  RH 65 ± 5 %", 8.5, color="#444")
        for j, (pp, lab) in enumerate(photos):
            cy = ch_top - 8.5 - (j + 1) * 13.6
            box(x + 1.3, cy, cw - 2.6, 12.6, TEMP[T], ec=TEMP_EDGE[T], lw=1.1, r=0.5)
            # lamp bar (light-tight compartment with own LED panel)
            ax.add_patch(Rectangle((x + 3, cy + 11.0), cw - 6, 0.7, fc="#f2c94c", ec="#a07d1c", lw=0.6, zorder=3))
            t(x + cw / 2, cy + 9.1, f"Compartment {chr(65 + j)}: {pp}", 8, weight="bold")
            t(x + cw / 2, cy + 7.0, f"({lab})", 7.5, color="#444")
            t(x + cw / 2, cy + 3.6, "18 pots: 2 species ×\n3 soil-moisture levels × 3 pots", 7, color="#333")
    else:
        box(x, ch_bot, cw, ch_top - ch_bot, "#f0f0f0", ec="#9aa0a6", lw=1.2, ls="--")
        t(x + cw / 2, ch_top - 2.6, "Phytotron chamber 4", 9, weight="bold", color="#6b7280")
        t(x + cw / 2, (ch_top + ch_bot) / 2 + 3,
          "Reserve / not used\n\nBackup if a chamber fails;\noptional 4th temperature\n(e.g. 30 °C) in a later\nextension study", 7.8,
          color="#6b7280")

t(50, 70.2,
  "Three temperatures × three photoperiods × three soil-moisture levels (3 × 3 × 3), as in the original design.\n"
  "Each run is one block: temperatures are re-assigned to growth phytotrons 1–3 at random in Run 2, and photoperiods to compartments A–C.\n"
  "Two runs × 3 growth phytotrons × 3 compartments × 18 pots = 324 pots; 20 weeks per run; equal PPFD from LED panels in every compartment.",
  7.6, color="#333")

# ---------------- (b) within-compartment layout ----------------
t(2, 63.5, "(b) Within-compartment layout (pots)", 10.5, ha="left", weight="bold")
bx, by, bw, bh = 3, 18, 55, 42
box(bx, by, bw, bh, "#f6f7fa", lw=1.2, r=1.2)
t(bx + bw / 2, by + bh - 2.5, "One compartment (example randomisation; re-randomised weekly)", 8)
rng = random.Random(7)
pots = [(sp, m) for sp in ("Dd", "Di") for m in (30, 60, 90) for _ in range(3)]
rng.shuffle(pots)
k = 0
for r in range(3):
    for c in range(6):
        cx = bx + 6 + c * 8.6
        cy = by + bh - 10.5 - r * 11
        sp, m = pots[k]; k += 1
        ax.add_patch(Circle((cx, cy), 3.4, fc=MOIST[m], ec=INK, lw=0.8, zorder=3))
        t(cx, cy + 0.8, sp, 8, weight="bold", color="white", zorder=4)
        t(cx, cy - 1.4, f"{m}%", 6.5, color="white", zorder=4)
for i, (m, lab) in enumerate([(30, "30% FC (drought)"), (60, "60% FC (optimum)"), (90, "90% FC (high)")]):
    lx = bx + 3.5 + i * 17.5
    ax.add_patch(Circle((lx, by + 3.2), 1.4, fc=MOIST[m], ec=INK, lw=0.7))
    t(lx + 2.2, by + 3.2, lab, 7.5, ha="left")

t(bx + bw / 2, 10,
  "Dd = D. dichotomum;  Di = D. intortum;  FC = field capacity.\n"
  "Pot = experimental unit for species and soil moisture;\n"
  "compartment = unit for photoperiod; phytotron × run = unit for temperature;\n"
  "run = block (RCBD). Split-split-plot analysis.", 7.4, style="italic", color="#333")

# ---------------- (c) pot structure ----------------
t(62, 63.5, "(c) Pot structure", 10.5, ha="left", weight="bold")
px = 84
pot = Polygon([(px - 7, 47), (px + 7, 47), (px + 5.5, 21), (px - 5.5, 21)], closed=True,
              fc="#c8784a", ec=INK, lw=1.0, zorder=2)
ax.add_patch(pot)
soil = Polygon([(px - 6, 45.5), (px + 6, 45.5), (px + 4.8, 22.5), (px - 4.8, 22.5)], closed=True,
               fc="#8b6a48", ec="none", zorder=3)
ax.add_patch(soil)
ax.add_patch(Rectangle((px - 4.6, 22.2), 9.2, 0.9, fc="#c9cdd2", ec="#777", lw=0.5, zorder=4))
for dx in (-3.5, 0, 3.5):
    ax.add_patch(Rectangle((px + dx - 0.4, 20.3), 0.8, 0.8, fc="white", ec=INK, lw=0.5, zorder=4))
ax.plot([px, px], [45.5, 59], color="#2f7a2f", lw=2, zorder=5)
for (lx, ly, ang) in [(px - 3, 55, 25), (px + 3, 57.5, -25), (px - 3.2, 50, 20), (px + 3.4, 52, -20)]:
    ax.add_patch(Ellipse((lx, ly), 5.5, 2.4, angle=ang, fc="#5a9a45", ec="#2f5a2a", lw=0.7, zorder=5))
ax.plot([px + 1.8, px + 1.8], [56, 37], color=INK, lw=1.2, zorder=5)
ax.add_patch(Rectangle((px + 1.1, 35.5), 1.4, 1.6, fc=INK, zorder=6))

def callout(tx, ty, s, ex, ey, ha="left"):
    t(tx, ty, s, 7.4, ha=ha, va="center")
    ax.plot([tx + (14 if ha == "left" else -10), ex], [ty, ey], color=INK, lw=0.6)

callout(61, 58, "One plant per pot\n(thinned from\ntwo seeds)", px - 4.5, 55.5)
callout(61, 42, "Steam-sterilised\nsubstrate: loam 50%,\nwashed sand 30%,\ncompost 20% (v/v);\n1–2 kg dry mass", px - 2, 34)
callout(61, 26, "Fine mesh over\ndrainage holes", px - 3, 22.6)
t(91.5, 33, "Moisture\nsensor,\n50 mm", 7.4, ha="left")
ax.plot([px + 2.6, 91.3], [36.3, 33], color=INK, lw=0.6)
t(80, 13, "Watered gravimetrically to target\npot mass for 30, 60 or 90% FC;\n"
  "basal P and K; 10–20 kg N ha⁻¹ equiv.\nstarter N.", 7.4, color="#333")

fig.savefig("figures/phytotron_design.png", dpi=200, facecolor="white")
fig.savefig("figures/phytotron_design.pdf", facecolor="white")

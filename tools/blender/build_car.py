# Builds the 2026-spec F1 car and exports assets/f1car-2026.glb.
#
#   /Applications/Blender.app/Contents/MacOS/Blender --background \
#       --python tools/blender/build_car.py
#
# Everything below is written in the GAME/glTF frame: +X right, +Y up,
# +Z forward (nose). f1_lib.V() converts to Blender's Z-up frame and the
# exporter's yup conversion puts it back, so these numbers ARE the numbers the
# game sees.
#
# Modelling approach: the big organic volumes (nose+monocoque+engine cover,
# sidepods, airbox, helmet, mirror pods) are low-poly lofted cages run through a
# Catmull-Clark subdivision modifier — that is what produces the smooth
# nose->monocoque blend and the sculpted sidepod undercut. Aerodynamic surfaces
# (wings, endplates, floor, diffuser) and the wheels are built dense and
# un-subdivided so their edges stay crisp and the tyre radius stays exactly
# 0.34 m (subdivision would shrink it).

import bpy
import os
import sys
import math

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from f1_lib import (V, clear_scene, mat, mkobj, empty, loft, revolve, sweep,
                    superellipse_ring, poly_ring, box, extrude_x, merge,
                    mirror_x, both_sides, tri_count, world_bbox, TAU)

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, '..', '..'))
OUT_GLB = os.path.join(ROOT, 'assets', 'f1car-2026.glb')

# ------------------------------------------------------------------ contract --
WHEELS = {
    'fl': (-0.82, 0.34, 1.55, 0.30),
    'fr': (0.82, 0.34, 1.55, 0.30),
    'rl': (-0.85, 0.34, -1.60, 0.38),
    'rr': (0.85, 0.34, -1.60, 0.38),
}
TYRE_R = 0.34

clamp = lambda t, a=0.0, b=1.0: a if t < a else (b if t > b else t)


def smoothstep(e0, e1, x):
    t = clamp((x - e0) / (e1 - e0) if e1 != e0 else 0.0)
    return t * t * (3 - 2 * t)


def lerp(a, b, t):
    return a + (b - a) * t


MATS = {}


def build_materials():
    MATS.clear()
    MATS.update({
        'body': mat('body', (0.68, 0.045, 0.065), 0.42, 0.33),
        'accent': mat('accent', (0.90, 0.91, 0.94), 0.45, 0.30),
        'carbon': mat('carbon', (0.040, 0.044, 0.052), 0.42, 0.42),
        'tyre': mat('tyre', (0.026, 0.026, 0.030), 0.02, 0.90),
        'rim': mat('rim', (0.40, 0.43, 0.48), 0.92, 0.26),
        'glow': mat('glow', (0.06, 0.012, 0.0), 0.0, 0.6,
                    (1.0, 0.30, 0.05), 2.2),
        'rainlight': mat('rainlight', (0.12, 0.012, 0.010), 0.0, 0.5,
                         (1.0, 0.06, 0.03), 3.2),
        'band': mat('band', (1.0, 0.78, 0.20), 0.10, 0.45),
        'glass': mat('glass', (0.78, 0.84, 0.92), 0.98, 0.05),
        'visor': mat('visor', (0.015, 0.016, 0.022), 0.10, 0.10),
        # the driver's lid gets its own two materials so js/car.js can apply the
        # brightness-lifted helmet palette instead of the raw team colours
        'helmet': mat('helmet', (0.88, 0.89, 0.92), 0.26, 0.28),
        'helmet_trim': mat('helmet_trim', (0.62, 0.06, 0.08), 0.28, 0.30),
    })


def Mt(k):
    return MATS[k]


# ===========================================================================
# 1. CHASSIS  — one continuous loft: nose tip -> monocoque -> engine cover -> tail
# ===========================================================================
# (z, half-width, bottom y, top y, upper squareness, lower squareness)
CHASSIS = [
    (2.260, 0.062, 0.148, 0.200, 2.0, 2.0),   # tip, welded into the wing mainplane
    (2.160, 0.092, 0.146, 0.242, 2.1, 2.2),
    (2.030, 0.118, 0.148, 0.294, 2.2, 2.4),
    (1.890, 0.142, 0.156, 0.350, 2.3, 2.5),
    (1.750, 0.160, 0.168, 0.402, 2.3, 2.6),
    (1.600, 0.176, 0.174, 0.452, 2.4, 2.7),
    (1.450, 0.190, 0.164, 0.496, 2.4, 2.8),
    (1.300, 0.198, 0.126, 0.538, 2.5, 3.0),   # front bulkhead drops onto the floor
    (1.150, 0.230, 0.078, 0.574, 2.5, 3.2),
    (1.000, 0.260, 0.070, 0.604, 2.6, 3.4),
    (0.850, 0.282, 0.068, 0.628, 2.6, 3.5),
    (0.700, 0.298, 0.066, 0.646, 2.6, 3.6),
    (0.550, 0.308, 0.065, 0.658, 2.6, 3.6),
    (0.400, 0.314, 0.065, 0.666, 2.6, 3.6),
    (0.250, 0.316, 0.066, 0.672, 2.6, 3.6),
    (0.100, 0.313, 0.068, 0.680, 2.6, 3.6),
    (-0.050, 0.306, 0.074, 0.698, 2.6, 3.5),
    (-0.200, 0.296, 0.082, 0.716, 2.6, 3.4),
    (-0.350, 0.280, 0.094, 0.712, 2.5, 3.2),
    (-0.500, 0.262, 0.112, 0.690, 2.5, 3.0),
    (-0.700, 0.240, 0.140, 0.644, 2.4, 2.9),
    (-0.900, 0.218, 0.172, 0.596, 2.4, 2.8),
    (-1.100, 0.198, 0.202, 0.550, 2.3, 2.7),
    (-1.300, 0.176, 0.228, 0.508, 2.3, 2.6),
    (-1.500, 0.152, 0.250, 0.470, 2.2, 2.5),
    (-1.700, 0.126, 0.268, 0.438, 2.2, 2.4),
    (-1.880, 0.100, 0.284, 0.414, 2.1, 2.3),
    (-2.000, 0.074, 0.298, 0.392, 2.0, 2.2),
    (-2.075, 0.038, 0.312, 0.370, 2.0, 2.0),  # rear crash-structure cap
]
CHASSIS_N = 28

COCKPIT_Z0, COCKPIT_Z1 = -0.075, 0.960
COCKPIT_HALF = 0.235
COCKPIT_DEPTH = 0.212


def dip_amount(z):
    """Depth of the cockpit scoop on the centreline at depth z."""
    if not (COCKPIT_Z0 < z < COCKPIT_Z1):
        return 0.0
    return COCKPIT_DEPTH * min(smoothstep(COCKPIT_Z0, COCKPIT_Z0 + 0.16, z),
                               smoothstep(COCKPIT_Z1, COCKPIT_Z1 - 0.22, z))


def cockpit_dip(x, y, z, cy):
    if y <= cy:
        return 0.0
    d = dip_amount(z)
    if d <= 0.0:
        return 0.0
    ax = abs(x) / COCKPIT_HALF
    if ax >= 1.0:
        return 0.0
    return d * math.cos(ax * math.pi * 0.5) ** 0.9


def chassis_at(z):
    """Interpolated (hw, y_bot, y_top) of the chassis cage at depth z."""
    if z >= CHASSIS[0][0]:
        r = CHASSIS[0]
        return r[1], r[2], r[3]
    for i in range(len(CHASSIS) - 1):
        a, b = CHASSIS[i], CHASSIS[i + 1]
        if b[0] <= z <= a[0]:
            t = (a[0] - z) / (a[0] - b[0])
            return lerp(a[1], b[1], t), lerp(a[2], b[2], t), lerp(a[3], b[3], t)
    r = CHASSIS[-1]
    return r[1], r[2], r[3]


def deck_at(z):
    """Top of the chassis after the cockpit scoop (centreline)."""
    return chassis_at(z)[2] - dip_amount(z)


def build_chassis(parent):
    rings = [superellipse_ring(z, hw, yb, yt, nu, nd, CHASSIS_N, cockpit_dip)
             for (z, hw, yb, yt, nu, nd) in CHASSIS]
    v, f = loft(rings)
    return mkobj('chassis', v, f, Mt('body'), subsurf=1, parent=parent)


# ===========================================================================
# 2. SIDEPODS — lofted cage with a real undercut, coke-bottled into the tail
# ===========================================================================
# normalised section outline: u = 0 at the (buried) inner wall, 1 at the outer
# skin; v = 0 at the undercut floor, 1 at the shoulder.
# The inner half of the top surface slopes DOWN (v 1.00 -> 0.80) so the pod
# shoulder and the monocoque flank form the 2022-spec "waterslide" channel
# between them. A flat pod top made the whole mid-section read as one smooth
# loaf in the pass-5 renders.
POD_SECTION = [
    (0.00, 0.62), (0.26, 0.30), (0.48, 0.11), (0.72, 0.02), (0.90, 0.11),
    (1.00, 0.31), (1.00, 0.64), (0.99, 0.85), (0.955, 0.965), (0.88, 1.00),
    (0.68, 0.985), (0.42, 0.905), (0.00, 0.800),
]
POD_X_IN = 0.055
# (z, x_out, y_bot, y_top)
POD_STATIONS = [
    (0.995, 0.400, 0.250, 0.440),
    (0.930, 0.520, 0.215, 0.497),
    (0.840, 0.610, 0.193, 0.523),
    (0.700, 0.678, 0.177, 0.537),
    (0.520, 0.712, 0.169, 0.539),
    (0.320, 0.722, 0.167, 0.533),
    (0.120, 0.718, 0.171, 0.523),
    (-0.080, 0.700, 0.181, 0.509),
    (-0.280, 0.664, 0.197, 0.493),
    (-0.470, 0.612, 0.217, 0.477),
    (-0.650, 0.540, 0.241, 0.463),
    (-0.830, 0.452, 0.267, 0.449),
    (-1.010, 0.358, 0.291, 0.437),
    (-1.190, 0.272, 0.313, 0.425),
    (-1.370, 0.192, 0.331, 0.413),
    (-1.520, 0.130, 0.343, 0.401),
    (-1.620, 0.098, 0.351, 0.389),
]


def pod_ring(z, xo, yb, yt, sign=1):
    h = yt - yb
    pts = [(sign * (POD_X_IN + (xo - POD_X_IN) * u), yb + h * v, z)
           for (u, v) in POD_SECTION]
    return pts if sign > 0 else list(reversed(pts))


def build_sidepods(parent):
    v, f = merge(loft([pod_ring(*s, sign=1) for s in POD_STATIONS]),
                 loft([pod_ring(*s, sign=-1) for s in POD_STATIONS]))
    return mkobj('sidepods', v, f, Mt('body'), subsurf=1, parent=parent)


def build_pod_inlets(parent):
    """Dark recessed inlet mouth on each pod front face (proud by 1.5 mm)."""
    z, xo, yb, yt = POD_STATIONS[0]
    h = yt - yb
    cx, cy = (POD_X_IN + xo) * 0.5, yb + h * 0.5
    parts = []
    for sgn in (1, -1):
        outline = []
        for (u, v) in POD_SECTION:
            x = POD_X_IN + (xo - POD_X_IN) * u
            y = yb + h * v
            outline.append((sgn * (cx + (x - cx) * 0.74), cy + (y - cy) * 0.74))
        parts.append(loft([[(x, y, 0.950) for (x, y) in outline],
                           [(x, y, 0.9965) for (x, y) in outline]]))
    v, f = merge(*parts)
    return mkobj('pod_inlets', v, f, Mt('carbon'), parent=parent)


def build_pod_winglets(parent):
    """Compact accent canards ahead of each pod inlet. The first pass used long
    shoulder shelves — from above they read as four white rectangles glued to the
    car, so they are now small leading-edge flics instead."""
    parts = []
    for (z0, z1, x0, x1, y, drop) in [(1.010, 1.170, 0.185, 0.520, 0.470, 0.030),
                                      (1.055, 1.170, 0.205, 0.500, 0.398, 0.022)]:
        outline = [(z0, y), (z1, y - drop), (z1, y - drop + 0.018), (z0, y + 0.018)]
        parts.append(extrude_x(outline, x0, x1))
        parts.append(extrude_x(outline, -x1, -x0))
    v, f = merge(*parts)
    return mkobj('pod_winglets', v, f, Mt('carbon'), parent=parent, smooth=False)


# ===========================================================================
# 3. FLOOR + DIFFUSER
# ===========================================================================
# (z, half-width, bottom y, top y, edge lip)
FLOOR = [
    (1.240, 0.430, 0.030, 0.086, 0.030),
    (1.080, 0.545, 0.030, 0.088, 0.042),
    (0.900, 0.660, 0.030, 0.090, 0.052),
    (0.680, 0.735, 0.030, 0.092, 0.058),
    (0.400, 0.762, 0.030, 0.094, 0.060),
    (0.100, 0.766, 0.030, 0.094, 0.060),
    (-0.200, 0.762, 0.030, 0.094, 0.060),
    (-0.520, 0.748, 0.030, 0.096, 0.058),
    (-0.820, 0.726, 0.030, 0.100, 0.052),
    (-1.080, 0.694, 0.032, 0.116, 0.044),
    (-1.320, 0.648, 0.048, 0.160, 0.032),
    (-1.540, 0.612, 0.096, 0.230, 0.020),
    (-1.760, 0.588, 0.170, 0.298, 0.012),
    (-1.930, 0.572, 0.238, 0.348, 0.008),
]


def floor_ring(z, hw, yb, yt, lip):
    return poly_ring(z, [
        (-hw + 0.016, yb), (hw - 0.016, yb),
        (hw, yb + 0.016), (hw, yt + lip - 0.014), (hw - 0.014, yt + lip),
        (hw - 0.090, yt + lip * 0.50), (hw - 0.180, yt), (0.0, yt),
        (-hw + 0.180, yt), (-hw + 0.090, yt + lip * 0.50),
        (-hw + 0.014, yt + lip), (-hw, yt + lip - 0.014), (-hw, yb + 0.016),
    ])


def build_floor(parent):
    v, f = loft([floor_ring(*s) for s in FLOOR])
    return mkobj('floor', v, f, Mt('carbon'), parent=parent)


def build_diffuser(parent):
    """Vertical strakes + outer fences hanging under the upswept floor exit."""
    parts = []
    # Six full-depth strakes silhouetted like comb teeth in the first pass; now
    # four shallower fences that stay inside the diffuser volume.
    strake = [(-1.300, 0.046), (-1.930, 0.234), (-1.930, 0.178), (-1.300, 0.030)]
    for x in (0.155, 0.395):
        for sgn in (1, -1):
            parts.append(extrude_x(strake, sgn * x - 0.013, sgn * x + 0.013))
    fence = [(-1.300, 0.042), (-1.945, 0.246), (-1.945, 0.098), (-1.300, 0.026)]
    for sgn in (1, -1):
        parts.append(extrude_x(fence, sgn * 0.560, sgn * 0.586))
    v, f = merge(*parts)
    return mkobj('diffuser', v, f, Mt('carbon'), parent=parent, smooth=False)


# ===========================================================================
# 4. WINGS
# ===========================================================================

def airfoil(chord, thick=0.10, camber=0.055, n=10, te=0.0022):
    up, lo = [], []
    for i in range(n + 1):
        u = (1 - math.cos(math.pi * i / n)) * 0.5
        yt = 5 * thick * chord * (0.2969 * math.sqrt(u) - 0.1260 * u
                                  - 0.3516 * u * u + 0.2843 * u ** 3
                                  - 0.1015 * u ** 4) + te * u
        yc = camber * chord * 4 * u * (1 - u)
        up.append((u * chord, yc + yt))
        lo.append((u * chord, yc - yt))
    return up + list(reversed(lo[1:]))


def wing_ring(x, z_le, y_le, chord, alpha, thick=0.10, camber=0.055):
    ca, sa = math.cos(alpha), math.sin(alpha)
    return [(x, y_le + s * sa + h * ca, z_le - (s * ca - h * sa))
            for (s, h) in airfoil(chord, thick, camber)]


def fw_ep_xc(y):
    """Front-wing endplate mid-plane |x| — curves outboard toward the ground."""
    t = clamp((y - 0.052) / 0.356)
    return 0.938 - 0.063 * t * t


def rw_ep_xc(y):
    return 0.742 - 0.016 * clamp((y - 0.440) / 0.526) ** 2


def span_element(name, material, parent, y_root, y_tip, z_le, chord, alpha,
                 x_tip, thick, camber, ease=2.0, stations=13, taper=0.15,
                 twist=0.28):
    """A wing element spanning the full width as ONE closed loft (no seam at
    x = 0, so no interior faces where two half-lofts would meet)."""
    rings = []
    for i in range(stations):
        t = -1.0 + 2.0 * i / (stations - 1)
        a = abs(t)
        x = x_tip * t
        y = lerp(y_root, y_tip, a ** ease)
        rings.append(wing_ring(x, z_le, y, chord * (1 - taper * a * a),
                               alpha * (1 + twist * a * a), thick, camber))
    v, f = loft(rings)
    return mkobj(name, v, f, material, parent=parent)


def half_element(y_root, y_tip, z_le, chord, alpha, x_root, x_tip, thick,
                 camber, ease=2.0, stations=9, taper=0.14, twist=0.25):
    """One outboard element, mirrored — used where the element stops inboard."""
    rings = []
    for i in range(stations):
        t = i / (stations - 1)
        x = lerp(x_root, x_tip, t)
        y = lerp(y_root, y_tip, t ** ease)
        rings.append(wing_ring(x, z_le, y, chord * (1 - taper * t * t),
                               alpha * (1 + twist * t * t), thick, camber))
    return both_sides(*loft(rings))


# Endplate profile: (height y, chord centre z, chord length). The top rings were
# below the upper flap's trailing edge in pass 4 (flap reached y = 0.389 against a
# 0.352 plate), so the plate is now taller than every element it encloses.
FW_EP = [
    (0.052, 2.368, 0.320),
    (0.100, 2.368, 0.354),
    (0.160, 2.360, 0.390),
    (0.220, 2.348, 0.416),
    (0.280, 2.332, 0.430),
    (0.330, 2.316, 0.424),
    (0.370, 2.302, 0.378),
    (0.396, 2.290, 0.286),
    (0.408, 2.282, 0.172),
]
RW_EP = [
    (0.440, -2.180, 0.400),
    (0.520, -2.206, 0.452),
    (0.630, -2.228, 0.492),
    (0.740, -2.246, 0.512),
    (0.850, -2.262, 0.504),
    (0.920, -2.276, 0.452),
    (0.952, -2.288, 0.330),
    (0.966, -2.296, 0.190),
]


def plate_ring(y, zc, length, xc, thick, n=16, squareness=11.0):
    e = 2.0 / squareness
    pts = []
    for k in range(n):
        t = TAU * k / n
        ct, st = math.cos(t), math.sin(t)
        pts.append((xc + (thick * 0.5) * math.copysign(abs(st) ** e, st), y,
                    zc + (length * 0.5) * math.copysign(abs(ct) ** e, ct)))
    return pts


def build_endplates(name, material, parent, table, x_fn, thick):
    v, f = both_sides(*loft([plate_ring(y, zc, L, x_fn(y), thick)
                             for (y, zc, L) in table]))
    return mkobj(name, v, f, material, parent=parent)


def build_front_wing(parent):
    # mainplane + lower flap share the body colour (the first pass put BOTH flaps
    # in accent, which made the whole wing read white)
    main = span_element('front_wing_main', Mt('body'), parent,
                        y_root=0.112, y_tip=0.152, z_le=2.520, chord=0.340,
                        alpha=0.10, x_tip=fw_ep_xc(0.152) + 0.002,
                        thick=0.105, camber=0.055, ease=2.2, stations=13)
    lower = half_element(0.182, 0.232, 2.448, 0.228, 0.28, 0.150,
                         fw_ep_xc(0.232) + 0.002, 0.095, 0.070)
    upper = half_element(0.248, 0.306, 2.382, 0.174, 0.46, 0.192,
                         fw_ep_xc(0.306) + 0.002, 0.095, 0.075)
    objs = [main,
            mkobj('front_wing_flap_lower', *lower, Mt('body'), parent=parent),
            mkobj('front_wing_flaps', *upper, Mt('accent'), parent=parent),
            build_endplates('front_wing_endplates', Mt('body'), parent,
                            FW_EP, fw_ep_xc, 0.022)]
    # footplate: outward-turning shelf welded through the endplate's lower skin
    parts = []
    foot = [(2.226, 0.060), (2.510, 0.060), (2.510, 0.080), (2.226, 0.080)]
    for sgn in (1, -1):
        lo, hi = sorted((sgn * 0.868, sgn * 0.950))
        parts.append(extrude_x(foot, lo, hi))
    v, f = merge(*parts)
    objs.append(mkobj('front_wing_footplates', v, f, Mt('carbon'),
                      parent=parent, smooth=False))
    return objs


def build_rear_wing(parent):
    objs = [
        span_element('rear_wing_main', Mt('accent'), parent, 0.742, 0.750,
                     -1.985, 0.360, 0.22, rw_ep_xc(0.76) + 0.002, 0.095, 0.060,
                     stations=11, taper=0.04, twist=0.06),
        span_element('rear_wing_flap', Mt('body'), parent, 0.856, 0.862,
                     -2.185, 0.190, 0.50, rw_ep_xc(0.87) + 0.002, 0.095, 0.075,
                     stations=11, taper=0.04, twist=0.06),
        span_element('beam_wing', Mt('carbon'), parent, 0.482, 0.486,
                     -1.986, 0.240, 0.16, 0.700, 0.090, 0.050,
                     stations=9, taper=0.05, twist=0.05),
        build_endplates('rear_wing_endplates', Mt('body'), parent,
                        RW_EP, rw_ep_xc, 0.024),
    ]
    parts = []
    for sgn in (1, -1):
        parts.append(sweep([(sgn * 0.085, 0.392, -2.008),
                            (sgn * 0.096, 0.545, -2.078),
                            (sgn * 0.100, 0.665, -2.060),
                            (sgn * 0.100, 0.744, -1.992)],
                           [0.032, 0.030, 0.028, 0.026], seg=8, aspect=1.9))
    v, f = merge(*parts)
    objs.append(mkobj('rear_wing_pylon', v, f, Mt('carbon'), parent=parent))
    return objs


# ===========================================================================
# 5. ENGINE COVER FURNITURE — airbox, shark fin, gearbox fairing, exhaust
# ===========================================================================

def build_airbox(parent):
    # Roll-hoop scoop. The first pass topped out at y = 0.71, which read as no
    # airbox at all; the crest now sits at 0.850, the tallest bodywork point.
    rings = [superellipse_ring(z, hw, yb, yt, 2.2, 2.6, 16) for (z, hw, yb, yt) in [
        (0.148, 0.098, 0.462, 0.596),
        (0.062, 0.150, 0.462, 0.752),
        (-0.040, 0.188, 0.530, 0.832),
        (-0.170, 0.198, 0.600, 0.852),
        (-0.310, 0.190, 0.640, 0.838),
        (-0.450, 0.170, 0.668, 0.798),
        (-0.570, 0.146, 0.658, 0.750),
        (-0.665, 0.120, 0.638, 0.698),
    ]]
    v, f = loft(rings)
    objs = [mkobj('airbox', v, f, Mt('body'), subsurf=1, parent=parent)]

    # 12-gon rings left a visibly faceted mouth against the subdivided airbox
    rings = [superellipse_ring(z, hw, yb, yt, 2.3, 2.6, 18) for (z, hw, yb, yt) in [
        (0.076, 0.108, 0.616, 0.740),
        (0.020, 0.124, 0.608, 0.786),
        (-0.040, 0.130, 0.606, 0.802),
        (-0.120, 0.130, 0.612, 0.802),
    ]]
    v, f = loft(rings)
    objs.append(mkobj('airbox_intake', v, f, Mt('carbon'), parent=parent))

    v, f = box(-0.040, 0.040, 0.844, 0.902, -0.262, -0.138)
    objs.append(mkobj('tcam', v, f, Mt('accent'), parent=parent, smooth=False))
    return objs


FIN_TOP = [(-0.600, 0.756), (-0.760, 0.790), (-0.960, 0.782), (-1.180, 0.752),
           (-1.420, 0.700), (-1.660, 0.626), (-1.870, 0.538), (-2.030, 0.442)]


def build_shark_fin(parent):
    outline = [(z, y) for (z, y) in FIN_TOP]
    for (z, _y) in reversed(FIN_TOP):
        outline.append((z, chassis_at(z)[2] - 0.050))
    v, f = extrude_x(outline, -0.013, 0.013)
    objs = [mkobj('shark_fin', v, f, Mt('body'), parent=parent, smooth=False)]
    # accent ridge swept along the fin crest (a box-per-segment version stepped
    # like a staircase in the first render pass)
    path = [(0.0, y - 0.008, z) for (z, y) in FIN_TOP]
    v, f = sweep(path, [0.017, 0.019, 0.020, 0.020, 0.019, 0.018, 0.016, 0.013],
                 seg=8, aspect=0.85)
    objs.append(mkobj('fin_cap', v, f, Mt('accent'), parent=parent))
    return objs


def build_rear_closeout(parent):
    # gearbox / rear crash-structure fairing (spin axis remapped onto Z)
    gv, gf = revolve([(-0.340, 0.075), (0.300, 0.152), (0.300, 0.062),
                      (-0.340, 0.036)], 14, axis='x')
    gv = [(rz, ry + 0.322, rx - 1.760) for (rx, ry, rz) in gv]
    ev, ef = revolve([(-0.115, 0.050), (0.115, 0.062), (0.115, 0.040),
                      (-0.115, 0.030)], 12, axis='x')
    ev = [(rz, ry + 0.404, rx - 2.120) for (rx, ry, rz) in ev]
    v, f = merge((gv, gf), (ev, ef))
    return mkobj('rear_closeout', v, f, Mt('carbon'), parent=parent)


# ===========================================================================
# 6. COCKPIT, HALO, DRIVER
# ===========================================================================
# Catmull-Clark pulls the scoop floor UP relative to the cage, so the dark
# liner has to be lifted or it hides inside the bodywork (measured in pass 3).
COCKPIT_LINER_LIFT = 0.060
COCKPIT_LINER = [(0.900, 0.110), (0.780, 0.150), (0.600, 0.172),
                 (0.400, 0.184), (0.200, 0.186), (0.040, 0.170),
                 (-0.040, 0.140)]


def build_cockpit(parent):
    rings = []
    for (z, hw) in COCKPIT_LINER:
        yt = deck_at(z) + COCKPIT_LINER_LIFT
        rings.append(superellipse_ring(z, hw, yt - 0.080, yt, 3.2, 3.2, 12))
    v, f = loft(rings)
    objs = [mkobj('cockpit_interior', v, f, Mt('carbon'), parent=parent)]

    v, f = merge(
        box(-0.148, 0.148, 0.452, 0.574, 0.020, 0.152),      # headrest
        box(-0.118, 0.118, 0.478, 0.532, 0.545, 0.628),      # dash top
    )
    objs.append(mkobj('headrest', v, f, Mt('carbon'), parent=parent,
                      smooth=False))
    return objs


HELMET = [  # (y, half-width x, z centre, half-length z)
    (0.496, 0.088, 0.334, 0.112),
    (0.532, 0.122, 0.331, 0.142),
    (0.574, 0.135, 0.328, 0.151),
    (0.612, 0.140, 0.326, 0.155),
    (0.652, 0.139, 0.324, 0.154),
    (0.692, 0.132, 0.322, 0.147),
    (0.726, 0.118, 0.320, 0.132),
    (0.752, 0.096, 0.318, 0.108),
    (0.769, 0.062, 0.316, 0.072),
    (0.776, 0.024, 0.315, 0.030),
]


def helmet_pt(y, hwx, zc, hwz, a, sq=2.3, scale=1.0):
    e = 2.0 / sq
    sa, ca = math.sin(a), math.cos(a)
    return (hwx * scale * math.copysign(abs(sa) ** e, sa), y,
            zc + hwz * scale * math.copysign(abs(ca) ** e, ca))


def helmet_ring(y, hwx, zc, hwz, n=16, scale=1.0):
    return [helmet_pt(y, hwx, zc, hwz, TAU * k / n, scale=scale)
            for k in range(n)]


def helmet_at(y):
    for i in range(len(HELMET) - 1):
        a, b = HELMET[i], HELMET[i + 1]
        if a[0] <= y <= b[0]:
            t = (y - a[0]) / (b[0] - a[0])
            return lerp(a[1], b[1], t), lerp(a[2], b[2], t), lerp(a[3], b[3], t)
    return HELMET[-1][1], HELMET[-1][2], HELMET[-1][3]


def build_driver(parent):
    v, f = loft([helmet_ring(*h) for h in HELMET])
    objs = [mkobj('helmet', v, f, Mt('helmet'), subsurf=1, parent=parent)]

    # trim band: a short raised loft around the helmet base
    rings = []
    for y in (0.554, 0.562, 0.584, 0.592):
        hwx, zc, hwz = helmet_at(y)
        rings.append(helmet_ring(y, hwx, zc, hwz, 16,
                                 scale=1.035 if y in (0.562, 0.584) else 1.0))
    v, f = loft(rings)
    objs.append(mkobj('helmet_band', v, f, Mt('helmet_trim'), parent=parent))

    # visor: curved shell with thickness over the front azimuths
    def visor_ring(y, s_out, s_in, n=9, a=1.32):
        hwx, zc, hwz = helmet_at(y)
        outer = [helmet_pt(y, hwx, zc, hwz, -a + 2 * a * i / (n - 1),
                           scale=s_out) for i in range(n)]
        inner = [helmet_pt(y, hwx, zc, hwz, a - 2 * a * i / (n - 1),
                           scale=s_in) for i in range(n)]
        return outer + inner
    v, f = loft([visor_ring(0.598, 1.034, 0.980),
                 visor_ring(0.636, 1.038, 0.980),
                 visor_ring(0.674, 1.036, 0.980),
                 visor_ring(0.706, 1.026, 0.980)])
    objs.append(mkobj('visor', v, f, Mt('visor'), parent=parent))

    v, f = merge(
        box(-0.112, 0.112, 0.512, 0.540, 0.618, 0.652),      # wheel rim
        box(-0.024, 0.024, 0.494, 0.530, 0.585, 0.640),      # column
        box(-0.086, 0.086, 0.528, 0.562, 0.598, 0.640),      # gloves
    )
    objs.append(mkobj('steering_wheel', v, f, Mt('carbon'), parent=parent,
                      smooth=False))
    return objs


def build_halo(parent):
    R, CY, CZ = 0.400, 0.779, 0.400
    n = 24
    arc = [(R * math.cos(math.pi * i / n),
            CY - 0.012 * math.sin(math.pi * i / n) ** 2,
            CZ + R * math.sin(math.pi * i / n)) for i in range(n + 1)]
    parts = [sweep(arc, 0.036, seg=8)]
    for sgn in (1, -1):
        parts.append(sweep([(sgn * R, CY, CZ),
                            (sgn * (R - 0.058), CY - 0.078, CZ - 0.118),
                            (sgn * 0.252, CY - 0.196, CZ - 0.272)],
                           [0.034, 0.032, 0.030], seg=8))
    parts.append(sweep([(0.0, CY - 0.012, CZ + R),
                        (0.0, CY - 0.092, CZ + R + 0.078),
                        (0.0, CY - 0.208, CZ + R + 0.142)],
                       [0.030, 0.032, 0.034], seg=8, aspect=0.55))
    v, f = merge(*parts)
    return mkobj('halo', v, f, Mt('carbon'), parent=parent)


def build_mirrors(parent):
    arms, pods, glass = [], [], []
    for sgn in (1, -1):
        arms.append(sweep([(sgn * 0.225, 0.556, 0.700),
                           (sgn * 0.370, 0.578, 0.742),
                           (sgn * 0.472, 0.590, 0.762)],
                          [0.021, 0.018, 0.016], seg=8, aspect=0.85))
        pv, pf = box(-0.062, 0.062, -0.046, 0.046, -0.032, 0.032)
        pods.append(([(x + sgn * 0.514, y + 0.592, z + 0.766)
                      for (x, y, z) in pv], pf))
        gv, gf = box(-0.052, 0.052, -0.038, 0.038, -0.009, 0.009)
        glass.append(([(x + sgn * 0.514, y + 0.592, z + 0.800)
                       for (x, y, z) in gv], gf))
    v, f = merge(*arms)
    o1 = mkobj('mirror_arms', v, f, Mt('carbon'), parent=parent)
    v, f = merge(*pods)
    o2 = mkobj('mirror_pods', v, f, Mt('carbon'), subsurf=2, parent=parent)
    v, f = merge(*glass)
    o3 = mkobj('mirror_glass', v, f, Mt('glass'), parent=parent, smooth=False)
    return [o1, o2, o3]


# ===========================================================================
# 7. SUSPENSION + BRAKE FURNITURE
# ===========================================================================
# (inboard point, outboard point, half-thickness) — right side; mirrored.
# Inboard ends are pulled inside the monocoque / gearbox skin (verified against
# the superellipse half-width at that station) so no arm ends in mid-air.
SUSP_F = [
    ((0.100, 0.330, 1.760), (0.652, 0.438, 1.560), 0.015),   # upper wishbone
    ((0.130, 0.360, 1.352), (0.652, 0.438, 1.560), 0.015),
    ((0.100, 0.215, 1.760), (0.652, 0.222, 1.556), 0.016),   # lower wishbone
    ((0.140, 0.200, 1.352), (0.652, 0.222, 1.556), 0.016),
    ((0.130, 0.270, 1.300), (0.648, 0.298, 1.442), 0.010),   # track rod
    ((0.652, 0.238, 1.612), (0.150, 0.420, 1.310), 0.011),   # pushrod
]
SUSP_R = [
    ((0.095, 0.400, -1.412), (0.638, 0.448, -1.596), 0.016),
    ((0.080, 0.370, -1.868), (0.638, 0.448, -1.596), 0.016),
    ((0.100, 0.300, -1.412), (0.638, 0.226, -1.600), 0.017),
    ((0.080, 0.310, -1.868), (0.638, 0.226, -1.600), 0.017),
    ((0.075, 0.320, -1.930), (0.642, 0.300, -1.744), 0.010),  # toe link
    ((0.638, 0.412, -1.520), (0.110, 0.310, -1.400), 0.011),  # pullrod
]


def build_suspension(name, table, parent):
    parts = []
    for (a, b, r) in table:
        for sgn in (1, -1):
            pa = (sgn * a[0], a[1], a[2])
            pb = (sgn * b[0], b[1], b[2])
            mid = tuple((pa[i] + pb[i]) * 0.5 for i in range(3))
            parts.append(sweep([pa, mid, pb], [r * 1.30, r, r * 0.85],
                               seg=8, aspect=2.9))
    v, f = merge(*parts)
    return mkobj(name, v, f, Mt('carbon'), parent=parent)


def build_brake_ducts(parent):
    parts = []
    for (z, xi, xo, y0, y1, zl) in [(1.550, 0.578, 0.660, 0.196, 0.470, 0.215),
                                    (-1.600, 0.566, 0.650, 0.196, 0.482, 0.235)]:
        outline = [(z - zl, y0 + 0.050), (z + zl, y0 + 0.088),
                   (z + zl * 0.85, y1), (z - zl * 0.90, y1 - 0.032)]
        parts.append(extrude_x(outline, xi, xo))
        parts.append(extrude_x(outline, -xo, -xi))
    v, f = merge(*parts)
    return mkobj('brake_ducts', v, f, Mt('carbon'), parent=parent, smooth=False)


def build_glows(parent):
    objs = []
    for (key, sgn) in (('brake_glow_l', -1), ('brake_glow_r', 1)):
        v, f = revolve([(-0.007, 0.196), (0.007, 0.196), (0.007, 0.128),
                        (-0.007, 0.128)], 22, axis='x')
        v = [(x + sgn * 0.562, y + 0.340, z + 1.550) for (x, y, z) in v]
        objs.append(mkobj(key, v, f, Mt('glow'), parent=parent))
    v, f = box(-0.062, 0.062, 0.318, 0.386, -2.132, -2.082)
    objs.append(mkobj('rain_light', v, f, Mt('rainlight'), parent=parent,
                      smooth=False))
    return objs


# ===========================================================================
# 8. WHEELS
# ===========================================================================

def tyre_profile(hw):
    """Closed (axial, radius) loop: tread crown at exactly r = TYRE_R."""
    R = TYRE_R
    outer = [
        (-hw, 0.226), (-hw, 0.264), (-hw * 0.985, 0.300), (-hw * 0.930, 0.324),
        (-hw * 0.820, 0.336), (-hw * 0.620, R), (-hw * 0.300, R),
        (hw * 0.300, R), (hw * 0.620, R), (hw * 0.820, 0.336),
        (hw * 0.930, 0.324), (hw * 0.985, 0.300), (hw, 0.264), (hw, 0.226),
    ]
    return outer + [(hw * 0.94, 0.214), (-hw * 0.94, 0.214)]


def build_wheel(key, parent):
    x, _y, _z, width = WHEELS[key]
    hw = width * 0.5
    face = 1.0 if x > 0 else -1.0

    v, f = revolve(tyre_profile(hw), 36, axis='x')
    v = [(vx, 0.0 if abs(vy) < 1e-9 else vy, vz) for (vx, vy, vz) in v]
    mkobj('tyre_' + key, v, f, Mt('tyre'), parent=parent)

    rim_prof = [
        (-hw * 0.90, 0.211), (hw * 0.90, 0.211),
        (hw * 0.90, 0.196), (hw * 0.66, 0.186), (hw * 0.48, 0.070),
        (hw * 0.86, 0.048), (hw * 0.86, 0.026),
        (-hw * 0.86, 0.026), (-hw * 0.86, 0.048), (-hw * 0.48, 0.070),
        (-hw * 0.66, 0.186), (-hw * 0.90, 0.196),
    ]
    parts = [revolve(rim_prof, 24, axis='x')]
    for i in range(7):
        a = TAU * i / 7
        ca, sa = math.cos(a), math.sin(a)
        sv, sf = box(-0.015, 0.015, -0.028, 0.028, 0.070, 0.186)
        parts.append(([(face * hw * 0.56 + bx, by * ca - bz * sa,
                        by * sa + bz * ca) for (bx, by, bz) in sv], sf))
    v, f = merge(*parts)
    mkobj('rim_' + key, v, f, Mt('rim'), parent=parent)

    bv, bf = revolve([(-0.011, 0.284), (0.011, 0.284), (0.011, 0.258),
                      (-0.011, 0.258)], 24, axis='x')
    bv = [(vx + face * (hw - 0.007), vy, vz) for (vx, vy, vz) in bv]
    mkobj('band_' + key, bv, bf, Mt('band'), parent=parent)


# ===========================================================================
# BUILD
# ===========================================================================

def build_all():
    build_materials()
    root = empty('body_root', (0, 0, 0))
    build_chassis(root)
    build_sidepods(root)
    build_pod_inlets(root)
    build_pod_winglets(root)
    build_floor(root)
    build_diffuser(root)
    build_front_wing(root)
    build_rear_wing(root)
    build_airbox(root)
    build_shark_fin(root)
    build_rear_closeout(root)
    build_cockpit(root)
    build_driver(root)
    build_halo(root)
    build_mirrors(root)
    build_suspension('susp_front', SUSP_F, root)
    build_suspension('susp_rear', SUSP_R, root)
    build_brake_ducts(root)
    build_glows(root)
    for key in ('fl', 'fr', 'rl', 'rr'):
        x, y, z, _w = WHEELS[key]
        build_wheel(key, empty('wheel_' + key, (x, y, z)))
    bpy.context.view_layer.update()
    return root


def probe():
    """Measure post-subdivision surfaces that seating decisions depend on.
    Guessing these was the cause of two earlier iteration rounds (hidden cockpit
    liner, invisible shark fin), so they are now read off the real mesh."""
    def sample(obj_name, pred, key):
        o = bpy.data.objects.get(obj_name)
        if o is None:
            return None
        best = None
        for v in o.data.vertices:
            w = o.matrix_world @ v.co
            a = (w.x, w.z, -w.y)          # back to authoring coords
            if pred(a):
                best = a[1] if best is None else key(best, a[1])
        return best

    floor = sample('chassis', lambda a: abs(a[0]) < 0.04 and 0.20 < a[2] < 0.50,
                   max)
    rail = sample('chassis', lambda a: 0.22 < abs(a[0]) < 0.27 and 0.20 < a[2] < 0.50,
                  max)
    deck = sample('chassis', lambda a: abs(a[0]) < 0.05 and -1.05 < a[2] < -0.85,
                  max)
    fin = sample('shark_fin', lambda a: -1.05 < a[2] < -0.85, max)
    liner = sample('cockpit_interior', lambda a: abs(a[0]) < 0.05 and 0.20 < a[2] < 0.50,
                   max)
    print('[probe] cockpit scoop floor y=%.3f  coaming rail y=%.3f  liner top y=%.3f'
          % (floor or -1, rail or -1, liner or -1))
    print('[probe] engine-cover deck y=%.3f  fin crest y=%.3f  fin proud %.3f'
          % (deck or -1, fin or -1, (fin or 0) - (deck or 0)))


def main():
    clear_scene()
    build_all()
    probe()

    meshes = [o for o in bpy.data.objects if o.type == 'MESH']
    tris = tri_count(meshes)
    lo, hi = world_bbox(meshes)
    print('[build] objects=%d meshes=%d tris=%d'
          % (len(bpy.data.objects), len(meshes), tris))
    print('[build] bbox  x[%+.3f %+.3f] y[%+.3f %+.3f] z[%+.3f %+.3f]'
          % (lo[0], hi[0], lo[1], hi[1], lo[2], hi[2]))
    print('[build] size  %.3f x %.3f x %.3f'
          % (hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]))

    os.makedirs(os.path.dirname(OUT_GLB), exist_ok=True)
    bpy.ops.export_scene.gltf(
        filepath=OUT_GLB, export_format='GLB', export_yup=True,
        export_apply=True, export_materials='EXPORT', export_normals=True,
    )
    print('[build] wrote %s (%.1f KB)'
          % (OUT_GLB, os.path.getsize(OUT_GLB) / 1024.0))


if __name__ == '__main__':
    main()

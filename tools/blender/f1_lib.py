# Shared bpy helpers for the F1-2026 car build / render / validate scripts.
#
# AUTHORING FRAME
# ---------------
# Every coordinate in build_car.py is written in the *game* frame, which is also
# the glTF frame the export contract demands:
#
#     +X = car's right    +Y = up    +Z = forward (nose)
#
# Blender is Z-up and the glTF exporter's `export_yup` conversion maps
# blender(x, y, z) -> gltf(x, z, -y).  So authoring coords are pushed through
# V() to get Blender coords, and the export puts them back exactly where they
# were written:
#
#     blender = (x, -z, y)   =>   gltf = (x, y, z)          (identity round-trip)
#
# V() is a proper rotation (det = +1), so it never flips triangle winding.

import bpy
import bmesh
import math
from mathutils import Vector

TAU = math.pi * 2


def V(x, y, z):
    """Authoring (x right, y up, z forward) -> Blender (x, y, z_up)."""
    return Vector((x, -z, y))


def clear_scene():
    bpy.ops.wm.read_factory_settings(use_empty=True)


# --------------------------------------------------------------- materials ---

def mat(name, color=(0.5, 0.5, 0.5), metallic=0.4, roughness=0.4,
        emission=None, emission_strength=0.0, alpha=1.0):
    """Create (or fetch) a Principled material. Names are exported verbatim."""
    m = bpy.data.materials.get(name)
    if m is not None:
        return m
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    bsdf = m.node_tree.nodes.get('Principled BSDF')
    def setv(sock, val):
        if sock in bsdf.inputs:
            bsdf.inputs[sock].default_value = val
    setv('Base Color', (color[0], color[1], color[2], 1.0))
    setv('Metallic', metallic)
    setv('Roughness', roughness)
    setv('Alpha', alpha)
    if emission is not None:
        setv('Emission Color', (emission[0], emission[1], emission[2], 1.0))
        setv('Emission Strength', emission_strength)
    else:
        setv('Emission Strength', 0.0)
    if alpha < 1.0:
        m.blend_method = 'BLEND'
    return m


# ------------------------------------------------------------ mesh creation --

def mkobj(name, verts, faces, material, subsurf=0, smooth=True, parent=None,
          origin=(0.0, 0.0, 0.0)):
    """Build a mesh object from authoring-frame verts/faces.

    verts   : list of (x, y, z) tuples in authoring coords, RELATIVE to `origin`
    faces   : list of index tuples (tris, quads or n-gons)
    subsurf : Catmull-Clark levels to add and immediately apply (0 = none)
    origin  : authoring-frame object origin; geometry stays local to it, which is
              what lets the wheel nodes hold wheel-local meshes.
    """
    me = bpy.data.meshes.new(name)
    me.from_pydata([tuple(V(*v)) for v in verts], [], [list(f) for f in faces])
    me.update()

    obj = bpy.data.objects.new(name, me)
    obj.location = V(*origin)
    bpy.context.collection.objects.link(obj)

    # consistent outward normals + weld coincident verts so the shell is manifold
    bm = bmesh.new()
    bm.from_mesh(me)
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-6)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    bm.to_mesh(me)
    bm.free()

    if subsurf:
        mod = obj.modifiers.new('subsurf', 'SUBSURF')
        mod.subdivision_type = 'CATMULL_CLARK'
        mod.levels = subsurf
        mod.render_levels = subsurf
        bpy.ops.object.select_all(action='DESELECT')
        obj.select_set(True)
        bpy.context.view_layer.objects.active = obj
        bpy.ops.object.modifier_apply(modifier=mod.name)

    for p in obj.data.polygons:
        p.use_smooth = smooth

    if material is not None:
        obj.data.materials.append(material)
    # Parenting keeps matrix_parent_inverse at identity on purpose: a wheel mesh
    # holds wheel-LOCAL geometry and must inherit its wheel node's transform,
    # and body_root sits at the origin so body meshes are unaffected.
    if parent is not None:
        obj.parent = parent
    return obj


def empty(name, pos=(0.0, 0.0, 0.0), parent=None):
    e = bpy.data.objects.new(name, None)
    e.empty_display_size = 0.1
    e.location = V(*pos)
    bpy.context.collection.objects.link(e)
    if parent is not None:
        e.parent = parent
    return e


# ----------------------------------------------------------- mesh generators --
# All of these return (verts, faces) in authoring coords; consistent winding so
# recalc_face_normals in mkobj() only has to pick a global sign.

def loft(rings, cap_start=True, cap_end=True):
    """Bridge a sequence of equal-length closed rings into a tube."""
    n = len(rings[0])
    for r in rings:
        assert len(r) == n, 'loft rings must all have the same length'
    verts = []
    for r in rings:
        verts.extend(r)
    faces = []
    for i in range(len(rings) - 1):
        a, b = i * n, (i + 1) * n
        for j in range(n):
            k = (j + 1) % n
            faces.append((a + j, a + k, b + k, b + j))
    if cap_start:
        faces.append(tuple(range(n - 1, -1, -1)))
    if cap_end:
        o = (len(rings) - 1) * n
        faces.append(tuple(range(o, o + n)))
    return verts, faces


def revolve(profile, segments, axis='x', cx=0.0, cy=0.0, cz=0.0):
    """Revolve a CLOSED 2-D profile to a solid of revolution (torus topology).

    profile : list of (along, radius) pairs, radius > 0, describing a closed loop
    axis    : 'x' -> spin about the X axis (wheels); 'y' -> about Y
    """
    m = len(profile)
    verts, faces = [], []
    for s in range(segments):
        a = TAU * s / segments
        ca, sa = math.cos(a), math.sin(a)
        for (t, r) in profile:
            if axis == 'x':
                verts.append((cx + t, cy + r * sa, cz + r * ca))
            else:
                verts.append((cx + r * ca, cy + t, cz + r * sa))
    for s in range(segments):
        a0, a1 = s * m, ((s + 1) % segments) * m
        for j in range(m):
            k = (j + 1) % m
            faces.append((a0 + j, a0 + k, a1 + k, a1 + j))
    return verts, faces


def _frames(pts, up_hint=(0.0, 1.0, 0.0)):
    """Parallel-transported orthonormal frames along a polyline."""
    P = [Vector(p) for p in pts]
    tans = []
    for i in range(len(P)):
        if i == 0:
            t = P[1] - P[0]
        elif i == len(P) - 1:
            t = P[-1] - P[-2]
        else:
            t = P[i + 1] - P[i - 1]
        if t.length < 1e-9:
            t = Vector((0, 0, 1))
        tans.append(t.normalized())
    up = Vector(up_hint)
    frames = []
    for t in tans:
        n = up - t * up.dot(t)
        if n.length < 1e-5:
            alt = Vector((1, 0, 0))
            n = alt - t * alt.dot(t)
        n.normalize()
        b = t.cross(n).normalized()
        frames.append((t, n, b))
        up = n
    return P, frames


def sweep(pts, radii, seg=8, aspect=1.0, up_hint=(0.0, 1.0, 0.0)):
    """Sweep an (optionally flattened) circle along a polyline. Capped solid.

    radii  : scalar or per-point radius
    aspect : section width multiplier along the frame's binormal (aerofoil-ish
             suspension arms use aspect < 1 so they read as blades, not straws)
    """
    P, frames = _frames(pts, up_hint)
    if not isinstance(radii, (list, tuple)):
        radii = [radii] * len(P)
    verts, faces = [], []
    for i, (p, (t, n, b)) in enumerate(zip(P, frames)):
        r = radii[i]
        for s in range(seg):
            a = TAU * s / seg
            off = n * (r * math.sin(a)) + b * (r * aspect * math.cos(a))
            verts.append(tuple(p + off))
    for i in range(len(P) - 1):
        a, c = i * seg, (i + 1) * seg
        for j in range(seg):
            k = (j + 1) % seg
            faces.append((a + j, a + k, c + k, c + j))
    faces.append(tuple(range(seg - 1, -1, -1)))
    o = (len(P) - 1) * seg
    faces.append(tuple(range(o, o + seg)))
    return verts, faces


def superellipse_ring(z, hw, y_bot, y_top, n_up=2.4, n_dn=3.2, n=24,
                      dip=None):
    """One chassis cross-section: a superellipse with independent upper / lower
    squareness. `dip(x, y, z, cy)` may pull the top surface down (cockpit)."""
    cy = (y_bot + y_top) * 0.5
    hu, hd = (y_top - cy), (cy - y_bot)
    pts = []
    for k in range(n):
        t = TAU * k / n
        ct, st = math.cos(t), math.sin(t)
        if st >= 0:
            e, hh = 2.0 / n_up, hu
        else:
            e, hh = 2.0 / n_dn, hd
        x = hw * math.copysign(abs(ct) ** e, ct)
        y = cy + hh * math.copysign(abs(st) ** e, st)
        if dip is not None:
            y -= dip(x, y, z, cy)
        pts.append((x, y, z))
    return pts


def poly_ring(z, pts2d):
    """Lift an explicit closed 2-D (x, y) outline to a ring at depth z."""
    return [(x, y, z) for (x, y) in pts2d]


def box(x0, x1, y0, y1, z0, z1):
    """Axis-aligned box as (verts, faces)."""
    v = [
        (x0, y0, z0), (x1, y0, z0), (x1, y1, z0), (x0, y1, z0),
        (x0, y0, z1), (x1, y0, z1), (x1, y1, z1), (x0, y1, z1),
    ]
    f = [(0, 1, 2, 3), (7, 6, 5, 4), (0, 4, 5, 1), (1, 5, 6, 2),
         (2, 6, 7, 3), (3, 7, 4, 0)]
    return v, f


def extrude_x(outline_zy, x0, x1):
    """Extrude a closed (z, y) outline along X into a solid slab."""
    n = len(outline_zy)
    verts = [(x0, y, z) for (z, y) in outline_zy] + \
            [(x1, y, z) for (z, y) in outline_zy]
    faces = []
    for j in range(n):
        k = (j + 1) % n
        faces.append((j, k, n + k, n + j))
    faces.append(tuple(range(n - 1, -1, -1)))
    faces.append(tuple(range(n, 2 * n)))
    return verts, faces


def merge(*parts):
    """Concatenate several (verts, faces) pairs into one mesh."""
    verts, faces = [], []
    for (v, f) in parts:
        o = len(verts)
        verts.extend(v)
        faces.extend([tuple(i + o for i in face) for face in f])
    return verts, faces


def mirror_x(verts, faces):
    """Mirrored copy with winding preserved (faces reversed)."""
    return [(-x, y, z) for (x, y, z) in verts], [tuple(reversed(f)) for f in faces]


def both_sides(verts, faces):
    return merge((verts, faces), mirror_x(verts, faces))


# ------------------------------------------------------------------ metrics --

def tri_count(objects=None):
    total = 0
    for o in (objects if objects is not None else bpy.data.objects):
        if o.type != 'MESH':
            continue
        for p in o.data.polygons:
            total += len(p.vertices) - 2
    return total


def world_bbox(objects=None):
    lo = [1e9, 1e9, 1e9]
    hi = [-1e9, -1e9, -1e9]
    for o in (objects if objects is not None else bpy.data.objects):
        if o.type != 'MESH':
            continue
        mw = o.matrix_world
        for v in o.data.vertices:
            w = mw @ v.co
            # back to authoring coords: authoring(x, y, z) = blender(x, z, -y)
            a = (w.x, w.z, -w.y)
            for i in range(3):
                lo[i] = min(lo[i], a[i])
                hi[i] = max(hi[i], a[i])
    return lo, hi

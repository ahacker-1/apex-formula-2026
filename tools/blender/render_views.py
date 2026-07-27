# Renders turntable checks (and the final hero shot) of the EXPORTED GLB, so the
# thing being judged is the actual game asset and not the in-memory build.
#
#   Blender --background --python tools/blender/render_views.py -- [hero]
#
# Views: front 3/4, rear 3/4, side, top at 800 px -> tools/blender/renders/
# `hero` renders a single 1200 px beauty frame to renders/hero.png.

import bpy
import os
import sys
import math
from mathutils import Vector

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from f1_lib import V

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, '..', '..'))
GLB = os.path.join(ROOT, 'assets', 'f1car-2026.glb')
OUT = os.path.join(HERE, 'renders')

ARGV = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
HERO = 'hero' in ARGV
DETAILS = 'detail' in ARGV

VIEWS = [
    # name,             camera position,        target,            lens
    ('front34', (5.20, 2.55, 6.60), (0.0, 0.44, 0.15), 55),
    ('rear34', (-5.10, 2.45, -6.70), (0.0, 0.48, -0.20), 55),
    ('side', (11.60, 0.92, 0.02), (0.0, 0.46, 0.02), 70),
    ('top', (0.03, 11.20, 0.04), (0.0, 0.28, 0.04), 62),
]
HERO_VIEW = ('hero', (6.55, 1.86, 5.75), (-0.05, 0.42, 0.06), 55)
# close-ups used while iterating on the model (Blender ... -- detail)
DETAIL = [
    ('d_cockpit', (1.85, 1.35, 2.05), (0.0, 0.60, 0.35), 70),
    ('d_finrear', (1.55, 1.05, -3.35), (0.0, 0.60, -1.35), 70),
    ('d_frontwing', (1.55, 0.62, 3.70), (0.30, 0.20, 2.35), 70),
    ('d_diffuser', (0.95, 0.42, -3.30), (0.0, 0.22, -1.85), 70),
]


def look_at(cam, pos, target):
    p, t = V(*pos), V(*target)
    cam.location = p
    cam.rotation_euler = (p - t).to_track_quat('Z', 'Y').to_euler()


def add_light(name, pos, energy, size, color=(1, 1, 1)):
    d = bpy.data.lights.new(name, 'AREA')
    d.energy = energy
    d.size = size
    d.color = color
    o = bpy.data.objects.new(name, d)
    o.location = V(*pos)
    o.rotation_euler = (V(*pos) - V(0, 0.4, 0)).to_track_quat('Z', 'Y').to_euler()
    bpy.context.collection.objects.link(o)
    return o


def setup_world(hero):
    w = bpy.data.worlds.new('w')
    bpy.context.scene.world = w
    w.use_nodes = True
    bg = w.node_tree.nodes['Background']
    bg.inputs[0].default_value = (0.055, 0.062, 0.075, 1.0)
    bg.inputs[1].default_value = 1.4 if hero else 1.8

    # studio ground so shadows and the floor edge read
    me = bpy.data.meshes.new('ground')
    s = 26.0
    me.from_pydata([tuple(V(-s, 0.0, -s)), tuple(V(s, 0.0, -s)),
                    tuple(V(s, 0.0, s)), tuple(V(-s, 0.0, s))],
                   [], [(0, 1, 2, 3)])
    me.update()
    m = bpy.data.materials.new('ground')
    m.use_nodes = True
    b = m.node_tree.nodes['Principled BSDF']
    b.inputs['Base Color'].default_value = (0.10, 0.105, 0.115, 1)
    b.inputs['Roughness'].default_value = 0.42
    b.inputs['Metallic'].default_value = 0.15
    me.materials.append(m)
    g = bpy.data.objects.new('ground', me)
    bpy.context.collection.objects.link(g)

    add_light('key', (3.6, 5.2, 4.4), 1400, 5.0)
    add_light('fill', (-4.6, 3.0, 1.4), 600, 6.0, (0.80, 0.86, 1.0))
    add_light('rim', (-2.2, 2.6, -6.2), 900, 4.0, (1.0, 0.92, 0.82))
    add_light('under', (0.0, 1.2, 3.4), 260, 4.0, (0.9, 0.94, 1.0))


def main():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=GLB)
    setup_world(HERO)

    sc = bpy.context.scene
    sc.render.engine = 'BLENDER_EEVEE'
    sc.render.film_transparent = False
    sc.render.image_settings.file_format = 'PNG'
    ee = sc.eevee
    for attr, val in (('taa_render_samples', 96), ('use_gtao', True),
                      ('use_shadows', True), ('use_raytracing', True)):
        if hasattr(ee, attr):
            setattr(ee, attr, val)
    sc.view_settings.view_transform = 'AgX' if 'AgX' in [
        v.name for v in bpy.types.ColorManagedViewSettings.bl_rna
        .properties['view_transform'].enum_items] else 'Standard'
    sc.view_settings.look = 'None'
    sc.view_settings.exposure = 0.55

    cd = bpy.data.cameras.new('cam')
    cam = bpy.data.objects.new('cam', cd)
    bpy.context.collection.objects.link(cam)
    sc.camera = cam

    os.makedirs(OUT, exist_ok=True)
    views = [HERO_VIEW] if HERO else (DETAIL if DETAILS else VIEWS)
    px = 1200 if HERO else 800
    sc.render.resolution_x = px
    sc.render.resolution_y = int(px * (0.68 if HERO else 0.72))
    sc.render.resolution_percentage = 100

    for (name, pos, target, lens) in views:
        cd.lens = lens
        look_at(cam, pos, target)
        # the top view is wide: the car lies along the frame's horizontal axis
        sc.render.resolution_y = int(px * (0.52 if name == 'top'
                                          else (0.68 if HERO else 0.72)))
        sc.render.filepath = os.path.join(OUT, name + '.png')
        bpy.ops.render.render(write_still=True)
        print('[render] %s -> %s' % (name, sc.render.filepath))


if __name__ == '__main__':
    main()

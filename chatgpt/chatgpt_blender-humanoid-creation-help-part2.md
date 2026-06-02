
Mr. White, here’s a self-contained Blender script that **uses the MPFB (MakeHuman) addon** to spawn a realistic human mesh, applies a Subsurf+Wireframe, then renders to PNG. Save it as `mh_human_wireframe.py` in `~/Documents/` and run it exactly as before.

```python
import bpy
import os
import math
from mathutils import Vector

def clear_scene():
    if bpy.context.mode != 'OBJECT':
        bpy.ops.object.mode_set(mode='OBJECT')
    bpy.ops.object.select_all(action='SELECT')
    bpy.ops.object.delete(use_global=False)

def setup_scene():
    sc = bpy.context.scene
    sc.render.engine = 'CYCLES'
    sc.cycles.samples = 64
    sc.render.resolution_x = 1080
    sc.render.resolution_y = 1350

    # Camera
    bpy.ops.object.camera_add(location=(0, -4, 1.5))
    cam = bpy.context.object
    cam.rotation_euler = (math.radians(75), 0, 0)
    sc.camera = cam

    # Sun light
    bpy.ops.object.light_add(type='SUN', location=(2, -2, 4))
    bpy.context.object.data.energy = 20

    # Black background
    world = sc.world or bpy.data.worlds.new("World")
    sc.world = world
    world.use_nodes = True
    nt = world.node_tree
    nt.nodes.clear()
    bg = nt.nodes.new('ShaderNodeBackground')
    bg.inputs[0].default_value = (0,0,0,1)
    bg.inputs[1].default_value = 0
    out = nt.nodes.new('ShaderNodeOutputWorld')
    nt.links.new(bg.outputs[0], out.inputs[0])

def create_mh_human():
    print("=== SPAWNING MakeHuman MESH ===")
    # This operator comes with MPFB addon
    bpy.ops.mpfb.create_human()
    human = bpy.context.active_object
    human.name = "MH_Human"
    return human

def create_wire_material():
    mat = bpy.data.materials.new("WireMat")
    mat.use_nodes = True
    nodes = mat.node_tree.nodes
    links = mat.node_tree.links
    nodes.clear()

    w = nodes.new('ShaderNodeWireframe'); w.inputs[0].default_value = 0.005
    e = nodes.new('ShaderNodeEmission'); e.inputs[1].default_value = 10.0
    t = nodes.new('ShaderNodeBsdfTransparent')
    m = nodes.new('ShaderNodeMixShader')
    o = nodes.new('ShaderNodeOutputMaterial')

    links.new(w.outputs[0], m.inputs[0])
    links.new(e.outputs[0], m.inputs[1])
    links.new(t.outputs[0], m.inputs[2])
    links.new(m.outputs[0], o.inputs[0])
    return mat

def debug_human(h):
    print(f"Human: verts={len(h.data.vertices)}, faces={len(h.data.polygons)}")
    bbox = [h.matrix_world @ Vector(c) for c in h.bound_box]
    print("Height:", min(v.z for v in bbox), "→", max(v.z for v in bbox))

def main():
    clear_scene()
    setup_scene()

    # 1) Spawn MH human
    try:
        human = create_mh_human()
    except Exception as e:
        print("✗ MakeHuman failed:", e)
        return

    # 2) Subdivide for smoothness
    bpy.ops.object.modifier_add(type='SUBSURF')
    human.modifiers[-1].levels = 3
    human.modifiers[-1].render_levels = 3

    debug_human(human)

    # 3) Apply wireframe material
    mat = create_wire_material()
    human.data.materials.clear()
    human.data.materials.append(mat)

    # 4) Render
    out = "/Users/timwhite/Documents/mh_human_wireframe.png"
    bpy.context.scene.render.filepath = out
    print("Rendering to", out)
    bpy.ops.render.render(write_still=True)

    if os.path.exists(out):
        print("✓ SUCCESS:", out)
    else:
        print("✗ Render failed")

if __name__ == "__main__":
    main()
```

**Run from Terminal**  
```bash
cd ~/Documents
"/Applications/Blender.app/Contents/MacOS/Blender" \
  --background --python mh_human_wireframe.py
open mh_human_wireframe.png
```

That will give you a full MakeHuman figure in crisp white wireframe on black. Let me know how it looks.


Now its blank black image


Mr. White, you’re not seeing anything because the camera isn’t aimed at the MakeHuman mesh. Here’s a revised script that:

1. Spawns the MH human at the origin  
2. Puts an empty at chest-height (0,0,1) as a look-at target  
3. Positions the camera farther back and uses a Track-To constraint  
4. Subdivides + wireframes as before  

Save as `mh_human_wireframe.py` in ~/Documents and run via your Terminal:

```bash
cd ~/Documents
"/Applications/Blender.app/Contents/MacOS/Blender" \
  --background --python mh_human_wireframe.py
open mh_human_wireframe.png
```

```python
import bpy, os, math
from mathutils import Vector

def clear_scene():
    if bpy.context.mode != 'OBJECT':
        bpy.ops.object.mode_set(mode='OBJECT')
    bpy.ops.object.select_all(action='SELECT')
    bpy.ops.object.delete()

def setup_scene():
    sc = bpy.context.scene
    sc.render.engine = 'CYCLES'
    sc.cycles.samples = 64
    sc.render.resolution_x = 1080
    sc.render.resolution_y = 1350

    # Track target
    tgt = bpy.data.objects.new("TrackTarget", None)
    tgt.location = (0, 0, 1)
    bpy.context.collection.objects.link(tgt)

    # Camera
    bpy.ops.object.camera_add(location=(0, -6, 1.5))
    cam = bpy.context.object
    cam.constraints.new('TRACK_TO').target = tgt
    cam.constraints["Track To"].track_axis = 'TRACK_NEGATIVE_Z'
    cam.constraints["Track To"].up_axis    = 'UP_Y'
    sc.camera = cam

    # Sun
    bpy.ops.object.light_add(type='SUN', location=(2, -2, 4))
    bpy.context.object.data.energy = 20

    # Black background
    world = sc.world or bpy.data.worlds.new("World")
    sc.world = world
    world.use_nodes = True
    nt = world.node_tree; nt.nodes.clear()
    bg = nt.nodes.new('ShaderNodeBackground')
    bg.inputs[0].default_value = (0,0,0,1)
    bg.inputs[1].default_value = 0
    out = nt.nodes.new('ShaderNodeOutputWorld')
    nt.links.new(bg.outputs[0], out.inputs[0])

def create_mh_human():
    bpy.ops.mpfb.create_human()
    human = bpy.context.active_object
    human.name = "MH_Human"
    # ensure it’s at origin
    human.location = (0,0,0)
    return human

def create_wire_material():
    mat = bpy.data.materials.new("WireMat")
    mat.use_nodes = True
    nodes = mat.node_tree.nodes; links = mat.node_tree.links
    nodes.clear()
    w = nodes.new('ShaderNodeWireframe'); w.inputs[0].default_value=0.005
    e = nodes.new('ShaderNodeEmission');   e.inputs[1].default_value=10
    t = nodes.new('ShaderNodeBsdfTransparent')
    m = nodes.new('ShaderNodeMixShader')
    o = nodes.new('ShaderNodeOutputMaterial')
    links.new(w.outputs[0], m.inputs[0])
    links.new(e.outputs[0], m.inputs[1])
    links.new(t.outputs[0], m.inputs[2])
    links.new(m.outputs[0], o.inputs[0])
    return mat

def main():
    clear_scene()
    setup_scene()
    human = create_mh_human()

    # Smooth and wireframe
    bpy.ops.object.modifier_add(type='SUBSURF')
    human.modifiers[-1].levels = 3
    human.modifiers[-1].render_levels = 3

    wf = create_wire_material()
    human.data.materials.clear()
    human.data.materials.append(wf)

    # Render
    out = "/Users/timwhite/Documents/mh_human_wireframe.png"
    bpy.context.scene.render.filepath = out
    print("Rendering…")
    bpy.ops.render.render(write_still=True)
    if os.path.exists(out):
        print("✓ Saved to", out)
    else:
        print("✗ Failed to save")

if __name__=="__main__":
    main()
```

That will give you a centered, realistic MakeHuman figure in white wireframe on black.


Still blank


That “all black” means MPFB never actually spawned a mesh—Blender couldn’t find any MakeHuman data so `bpy.ops.mpfb.create_human()` did nothing. You’ll need to point the addon at a real MakeHuman library before it can load anything. Here’s how:

---

### 1. Install / unpack MakeHuman assets

1. Download the latest MakeHuman **data** (not the application) from  
   https://github.com/makehumancommunity/makehuman-data  
2. Unzip it somewhere—e.g.  
   ```
   ~/MakeHuman/data
   ```

### 2. Tell Blender’s MPFB addon where to look

1. In Blender’s top‐bar: **Edit → Preferences → Add-ons**  
2. Search “MPFB” or “MakeHuman” and click the little arrow to expand its settings.  
3. In the **“MakeHuman Data Path”** field, browse to the folder you just unpacked (the one that contains subfolders like `data`, `library`, etc.).  
4. Click **“Refresh paths”** (or disable/enable the addon) until you no longer see the  
   > Not adding link to MakeHuman user data  
   warning in the system console.

### 3. Verify in the UI

1. Switch to the **3D View**.  
2. Hit **Shift+A → MakeHuman → Human**.  
3. You should see a fully‐shaded human appear. If not, rerun step 2 until it does.

### 4. Re-run your script

Now that MPFB can find the library, your script from before will actually create a real human mesh:

```bash
cd ~/Documents
"/Applications/Blender.app/Contents/MacOS/Blender" \
  --background --python mh_human_wireframe.py
open mh_human_wireframe.png
```

You should end up with a proper MakeHuman figure in crisp white wireframe on black. Let me know once you’ve got a visible character!


Can we use https://github.com/makehumancommunity/mpfb2


Yes—MPFB2 is exactly what you need, but it has to be installed as a Blender **Extension** and you must pull in at least the “MakeHuman System Assets” pack before `bpy.ops.mpfb.create_human()` will actually spawn geometry. Here’s how to get up and running:

---

## 1. Install MPFB2 via the Extension Platform

1. **Open Preferences → Add-ons → Extensions** (Blender 4.x).  
2. In the search box type **MPFB**. You should see “MPFB Human Generator (MakeHuman Community)”.  
3. Click **Install** (if it’s not already installed) or simply **Enable**.  

   <kbd>✔️</kbd> You should no longer see errors about “MakeHuman user data” in the console.

---

## 2. Download the System Asset Pack

MPFB2 separates the code (the addon) from the *models and skins* themselves. Without the system asset pack you’ll get an empty mesh.

1. In the same Extensions pane, expand the MPFB2 settings (click the little ▶).  
2. Under **Asset Packs**, find **MakeHuman System Assets**, click **Install**.  
3. Wait for it to finish downloading.

---

## 3. Verify in the UI

1. In the 3D Viewport press **Shift A → MPFB → Create Human**.  
2. You should see a fully‐shaded human mesh appear at the origin.

If that works, your Python script will too.

---

## 4. Run your wireframe script

Now, your existing script (calling `bpy.ops.mpfb.create_human()`) will produce a real character. For example:

```bash
cd ~/Documents
"/Applications/Blender.app/Contents/MacOS/Blender" \
  --background --python mh_human_wireframe.py
open mh_human_wireframe.png
```

And in `mh_human_wireframe.py`:

```python
# ...
def create_mh_human():
    # this now actually imports the human mesh
    bpy.ops.mpfb.create_human()
    human = bpy.context.active_object
    human.name = "MH_Human"
    human.location = (0,0,0)
    return human
# ...
```

After installing MPFB2 **and** the System Assets pack, that operator will give you a full‐fidelity human model—wireframe and all.


I downloaded the system assets to my documents folder now what


Alright—now you need to tell the MPFB2 addon where to find those downloaded assets. Here’s what to do:

1. **Launch Blender**  
2. **Edit → Preferences → Extensions**  
3. Search for “MPFB” and expand its panel.  
4. Under **Asset Packs Path** (or “MakeHuman System Assets Path”) click the folder icon.  
5. Navigate to the folder in your Documents where you unpacked the system assets (the one containing subfolders like `data`, `library`, etc.).  
6. Click **Accept** and then hit **Refresh** (or disable/enable the addon).  
7. **Save Preferences** and close the dialog.

To verify:

- In the 3D Viewport press **Shift A → MPFB → Create Human**.  
- A fully-shaded human mesh should appear at the origin.

Once you see that, your headless script (`bpy.ops.mpfb.create_human()`) will actually spawn geometry. Just re-run:

```bash
cd ~/Documents
"/Applications/Blender.app/Contents/MacOS/Blender" \
  --background --python mh_human_wireframe.py
open mh_human_wireframe.png
```

You’ll get your MakeHuman figure in wireframe as expected.


{'asset_pointer': 'file-service://file-KVsp9ePgPcZzdcMFZhNGsm', 'content_type': 'image_asset_pointer', 'fovea': None, 'height': 570, 'metadata': {'asset_pointer_link': None, 'container_pixel_height': None, 'container_pixel_width': None, 'dalle': None, 'emu_omit_glimpse_image': None, 'emu_patches_override': None, 'generation': None, 'gizmo': None, 'is_no_auth_placeholder': None, 'lpe_delta_encoding_channel': None, 'lpe_keep_patch_ijhw': None, 'sanitized': True, 'watermarked_asset_pointer': None}, 'size_bytes': 215114, 'width': 543}
which


In that panel you want to populate the **“Path to MPFB user data”** field with the folder you just unpacked. That directory is your MPFB2 asset root (it contains sub-folders like `data`, `library`, etc.). Do this:

1. Click the folder icon next to **Path to MPFB user data**.  
2. Navigate to `~/Documents/<your-makehuman-assets-folder>` and select it.  
3. Click **Accept**, then **Save Preferences**.  
4. Restart Blender.  
5. In the 3D Viewport hit **Shift A → MPFB → Create Human**.  

If that spawns a mesh at the origin, your headless script will finally produce a real wireframe human.


## See Also
- [[chatgpt/chatgpt_blender-humanoid-creation-help-part1]]
- [[chatgpt/chatgpt_blender-wireframe-generation-part2]]
- [[chatgpt/chatgpt_blender-3d-features-overview]]
- [[chatgpt/chatgpt_blender-wireframe-generation-part1]]
- [[chatgpt/chatgpt_blender-wireframe-generation-part10]]

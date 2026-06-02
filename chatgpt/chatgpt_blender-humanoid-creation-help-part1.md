---
title: "Blender humanoid creation help"
type: essay
created: 2025-06-21
updated: 2025-06-21
source: chatgpt-export
conversation_id: 68560d8e-ee60-8007-b7a4-6f93d1d57a5a
message_count: 24
tags: [chatgpt, import, code, long-form]
---
# Blender humanoid creation help

> Conversation ID: 68560d8e-ee60-8007-b7a4-6f93d1d57a5a
> Created: 2025-06-21T01:40:31Z
> Updated: 2025-06-21T02:41:19Z
> Messages: 24


{'asset_pointer': 'file-service://file-64Am9JU9STUHAPJQse6vLa', 'content_type': 'image_asset_pointer', 'fovea': None, 'height': 1350, 'metadata': {'asset_pointer_link': None, 'container_pixel_height': None, 'container_pixel_width': None, 'dalle': None, 'emu_omit_glimpse_image': None, 'emu_patches_override': None, 'generation': None, 'gizmo': None, 'is_no_auth_placeholder': None, 'lpe_delta_encoding_channel': None, 'lpe_keep_patch_ijhw': None, 'sanitized': True, 'watermarked_asset_pointer': None}, 'size_bytes': 1164524, 'width': 1080}
import bpy
import math
import os
from mathutils import Vector

# Simple but clearly human-shaped wireframe generator
# Focus on getting basic human proportions right first

def clear_scene():
    """Clear everything"""
    if bpy.context.mode != 'OBJECT':
        bpy.ops.object.mode_set(mode='OBJECT')
    
    bpy.ops.object.select_all(action='SELECT')
    bpy.ops.object.delete(use_global=False)

def test_makehuman_thoroughly():
    """Test MakeHuman with all possible methods"""
    print("=== TESTING MAKEHUMAN THOROUGHLY ===")
    
    if not hasattr(bpy.ops, 'mpfb'):
        print("MPFB not available")
        return None
    
    print("MPFB addon found. Available operators:")
    mpfb_ops = [attr for attr in dir(bpy.ops.mpfb) if not attr.startswith('_')]
    for op in mpfb_ops:
        print(f"  - bpy.ops.mpfb.{op}")
    
    # Method 1: Standard create_character
    if hasattr(bpy.ops.mpfb, 'create_character'):
        try:
            print("\nTrying: bpy.ops.mpfb.create_character()")
            bpy.ops.mpfb.create_character()
            
            if bpy.context.active_object:
                human = bpy.context.active_object
                print(f"✓ Created: {human.name} with {len(human.data.vertices)} vertices")
                
                # Check if it looks human-like
                if len(human.data.vertices) > 1000:
                    print("✓ Vertex count suggests proper human model")
                    return human
                else:
                    print("⚠ Low vertex count, may not be detailed")
                    
        except Exception as e:
            print(f"✗ create_character failed: {e}")
    
    # Method 2: Try other operators
    for op_name in ['import_body', 'load_human', 'new_human', 'add_human']:
        if hasattr(bpy.ops.mpfb, op_name):
            try:
                print(f"\nTrying: bpy.ops.mpfb.{op_name}()")
                getattr(bpy.ops.mpfb, op_name)()
                
                if bpy.context.active_object:
                    human = bpy.context.active_object
                    print(f"✓ Created with {op_name}: {human.name}")
                    return human
                    
            except Exception as e:
                print(f"✗ {op_name} failed: {e}")
    
    print("✗ All MakeHuman methods failed")
    return None

def create_simple_human_shape():
    """Create simple but clearly human-shaped mesh using basic primitives"""
    print("=== CREATING SIMPLE HUMAN SHAPE ===")
    
    # Start with cube for torso
    bpy.ops.mesh.primitive_cube_add(size=1, location=(0, 0, 0.5))
    torso = bpy.context.object
    torso.name = "Human_Torso"
    
    # Scale to human torso proportions
    torso.scale = (0.6, 0.3, 1.2)  # Width, depth, height
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    
    # Add head (sphere)
    bpy.ops.mesh.primitive_uv_sphere_add(radius=0.25, location=(0, 0, 1.4))
    head = bpy.context.object
    head.name = "Human_Head"
    
    # Add arms (cylinders)
    # Left arm
    bpy.ops.mesh.primitive_cylinder_add(
        radius=0.08, depth=0.8,
        location=(-0.5, 0, 0.8),
        rotation=(0, 0, math.radians(-20))
    )
    left_arm = bpy.context.object
    left_arm.name = "Human_LeftArm"
    
    # Right arm
    bpy.ops.mesh.primitive_cylinder_add(
        radius=0.08, depth=0.8,
        location=(0.5, 0, 0.8),
        rotation=(0, 0, math.radians(20))
    )
    right_arm = bpy.context.object
    right_arm.name = "Human_RightArm"
    
    # Join all parts into one object
    bpy.ops.object.select_all(action='DESELECT')
    torso.select_set(True)
    head.select_set(True)
    left_arm.select_set(True)
    right_arm.select_set(True)
    
    bpy.context.view_layer.objects.active = torso
    bpy.ops.object.join()
    
    # Add subdivision for smooth wireframe
    bpy.ops.object.modifier_add(type='SUBSURF')
    torso.modifiers[-1].levels = 2
    torso.modifiers[-1].render_levels = 3
    
    print(f"✓ Simple human created: {len(torso.data.vertices)} vertices")
    return torso

def create_metaball_human():
    """Create human using metaballs for organic shape"""
    print("=== CREATING METABALL HUMAN ===")
    
    try:
        # Create metaball for torso
        bpy.ops.object.metaball_add(type='ELLIPSOID', location=(0, 0, 0.5))
        torso_meta = bpy.context.object
        torso_meta.data.elements[0].size_x = 0.6
        torso_meta.data.elements[0].size_y = 0.3
        torso_meta.data.elements[0].size_z = 0.8
        
        # Add metaball for head
        bpy.ops.object.metaball_add(type='BALL', location=(0, 0, 1.3))
        head_meta = bpy.context.object
        head_meta.data.elements[0].radius = 0.25
        
        # Add metaballs for arms
        bpy.ops.object.metaball_add(type='CAPSULE', location=(-0.45, 0, 0.7))
        left_arm_meta = bpy.context.object
        left_arm_meta.rotation_euler = (0, 0, math.radians(-20))
        left_arm_meta.data.elements[0].size_x = 0.08
        left_arm_meta.data.elements[0].size_z = 0.4
        
        bpy.ops.object.metaball_add(type='CAPSULE', location=(0.45, 0, 0.7))
        right_arm_meta = bpy.context.object
        right_arm_meta.rotation_euler = (0, 0, math.radians(20))
        right_arm_meta.data.elements[0].size_x = 0.08
        right_arm_meta.data.elements[0].size_z = 0.4
        
        # Convert to mesh
        bpy.context.view_layer.objects.active = torso_meta
        bpy.ops.object.convert(target='MESH')
        
        human = bpy.context.object
        human.name = "Metaball_Human"
        
        # Add subdivision
        bpy.ops.object.modifier_add(type='SUBSURF')
        human.modifiers[-1].levels = 2
        
        print(f"✓ Metaball human created: {len(human.data.vertices)} vertices")
        return human
        
    except Exception as e:
        print(f"✗ Metaball human failed: {e}")
        return None

def setup_scene():
    """Setup scene for wireframe rendering"""
    print("=== SETTING UP SCENE ===")
    
    scene = bpy.context.scene
    scene.render.engine = 'CYCLES'
    scene.render.resolution_x = 1080
    scene.render.resolution_y = 1350
    scene.cycles.samples = 32
    
    # Camera
    bpy.ops.object.camera_add(location=(0, -3, 1))
    camera = bpy.context.object
    camera.rotation_euler = (math.radians(75), 0, 0)
    camera.data.lens = 50
    bpy.context.scene.camera = camera
    
    # Strong lighting
    bpy.ops.object.light_add(type='SUN', location=(2, -2, 4))
    sun = bpy.context.object
    sun.data.energy = 20
    
    # Black background
    world = bpy.context.scene.world
    if not world:
        world = bpy.data.worlds.new("World")
        bpy.context.scene.world = world
    
    world.use_nodes = True
    world.node_tree.nodes.clear()
    
    bg = world.node_tree.nodes.new('ShaderNodeBackground')
    bg.inputs[0].default_value = (0, 0, 0, 1)
    bg.inputs[1].default_value = 0
    
    output = world.node_tree.nodes.new('ShaderNodeOutputWorld')
    world.node_tree.links.new(bg.outputs[0], output.inputs[0])

def create_wireframe_material():
    """Create wireframe material"""
    mat = bpy.data.materials.new(name="Simple_Wireframe")
    mat.use_nodes = True
    mat.node_tree.nodes.clear()
    
    wireframe = mat.node_tree.nodes.new('ShaderNodeWireframe')
    wireframe.inputs[0].default_value = 0.008
    
    emission = mat.node_tree.nodes.new('ShaderNodeEmission')
    emission.inputs[0].default_value = (1, 1, 1, 1)
    emission.inputs[1].default_value = 8.0
    
    mix = mat.node_tree.nodes.new('ShaderNodeMixShader')
    transparent = mat.node_tree.nodes.new('ShaderNodeBsdfTransparent')
    output = mat.node_tree.nodes.new('ShaderNodeOutputMaterial')
    
    mat.node_tree.links.new(wireframe.outputs[0], mix.inputs[0])
    mat.node_tree.links.new(emission.outputs[0], mix.inputs[1])
    mat.node_tree.links.new(transparent.outputs[0], mix.inputs[2])
    mat.node_tree.links.new(mix.outputs[0], output.inputs[0])
    
    return mat

def debug_human(human):
    """Debug human object properties"""
    print(f"\n=== DEBUGGING HUMAN: {human.name} ===")
    print(f"Type: {human.type}")
    print(f"Vertices: {len(human.data.vertices)}")
    print(f"Faces: {len(human.data.polygons)}")
    print(f"Location: {human.location}")
    print(f"Scale: {human.scale}")
    print(f"Dimensions: {human.dimensions}")
    
    # Check bounding box
    bbox = [human.matrix_world @ Vector(corner) for corner in human.bound_box]
    min_z = min(v.z for v in bbox)
    max_z = max(v.z for v in bbox)
    print(f"Height range: {min_z:.2f} to {max_z:.2f}")
    
    # Check modifiers
    print(f"Modifiers: {[mod.name for mod in human.modifiers]}")

def main():
    """Main execution - try multiple approaches"""
    print("=== SIMPLE HUMAN WIREFRAME TEST ===")
    
    clear_scene()
    setup_scene()
    
    # Method 1: Try MakeHuman thoroughly
    human = test_makehuman_thoroughly()
    
    # Method 2: Try metaball human
    if not human:
        print("\nMakeHuman failed, trying metaball approach...")
        human = create_metaball_human()
    
    # Method 3: Fallback to simple primitives
    if not human:
        print("\nMetaball failed, using simple primitive approach...")
        human = create_simple_human_shape()
    
    if not human:
        print("ERROR: All methods failed!")
        return
    
    # Debug the human
    debug_human(human)
    
    # Apply wireframe
    wireframe_mat = create_wireframe_material()
    human.data.materials.clear()
    human.data.materials.append(wireframe_mat)
    
    # Render
    output_path = "/Users/timwhite/Documents/simple_human_wireframe.png"
    bpy.context.scene.render.filepath = output_path
    
    print(f"\nRendering human wireframe...")
    bpy.ops.render.render(write_still=True)
    
    if os.path.exists(output_path):
        print(f"✓ SUCCESS: {output_path}")
        print("Check if this looks more human-like!")
    else:
        print("✗ Render failed")

if __name__ == "__main__":
    main()

Were trying to create a human looking wireframe mesh image but its coming out like the attached Image


That screenshot isn’t a Blender render of your cube+sphere/cylinder humanoid at all, but a quiver-style vector plot—so you’re not running your `bpy` script in Blender’s Python environment (or you’re opening the wrong output file). A few quick checks/fixes:

1. **Run inside Blender**  
   ```bash
   blender --background --python your_script.py
   ```  
   or paste the text into Blender’s Text Editor and hit “Run Script.” Ordinary Python won’t import `bpy` and will fall back to whatever Matplotlib-style demo you’ve installed.

2. **Use the Wireframe Modifier** (simpler than ShaderNodeWireframe)  
   ```python
   # after join & subsurf
   obj = bpy.context.active_object
   bpy.ops.object.modifier_add(type='WIREFRAME')
   obj.modifiers["Wireframe"].thickness = 0.02
   bpy.ops.object.modifier_apply(modifier="Wireframe")
   ```
   That gives solid edges on your torso/head/arms mesh.

3. **Confirm you actually created your humanoid mesh**  
   - Print `bpy.context.scene.objects` after `main()` to see what objects exist.  
   - Make sure `create_simple_human_shape()` is being called (print a log before/after).

4. **Double-check your render**  
   - `scene.render.filepath` matches the PNG you’re opening.  
   - After render, open that exact file, not an old test image.

If you still get a sphere or arrows, paste the Blender Console output here and we can pinpoint which branch of your `main()` is actually executing.


{'asset_pointer': 'file-service://file-ErMX1W2wMfQ3FsMG8Z6fkd', 'content_type': 'image_asset_pointer', 'fovea': None, 'height': 956, 'metadata': {'asset_pointer_link': None, 'container_pixel_height': None, 'container_pixel_width': None, 'dalle': None, 'emu_omit_glimpse_image': None, 'emu_patches_override': None, 'generation': None, 'gizmo': None, 'is_no_auth_placeholder': None, 'lpe_delta_encoding_channel': None, 'lpe_keep_patch_ijhw': None, 'sanitized': True, 'watermarked_asset_pointer': None}, 'size_bytes': 1093027, 'width': 1470}
Walk me through what to do


Mr. White, you’ve been typing shell commands into Blender’s Python console instead of your macOS Terminal. Let’s fix that in two quick ways:

---

### A) Run from the Terminal

1. **Save your script**  
   – Export your text block in Blender’s Text Editor as `simple_human_wireframe.py` into, say, `~/blender-scripts/`.

2. **Open Terminal**  
   – Press ⌘ Space → type “Terminal” → ↩.

3. **`cd` to your script folder**  
   ```bash
   cd ~/blender-scripts
   ```

4. **Invoke Blender’s CLI**  
   ```bash
   "/Applications/Blender.app/Contents/MacOS/Blender" --background --python simple_human_wireframe.py
   ```
   – This runs Blender headless, executes your script, dumps the PNG.

5. **Check your render**  
   – Open Finder → Documents → `simple_human_wireframe.png`.

---

### B) Run inside Blender’s UI

1. **Switch to Scripting workspace**  
   – Top-bar → “Scripting.”

2. **Open your `.py` file**  
   – In the Text Editor panel: click “Open,” navigate to `simple_human_wireframe.py`.

3. **Hit ▶ Run Script**  
   – That little play icon at the Text Editor header.

4. **Watch the System Console**  
   – Window → Toggle System Console for `print(...)` logs and success message.

5. **Locate the PNG**  
   – It’ll appear at `/Users/timwhite/Documents/simple_human_wireframe.png`.

---

After you’ve done one of these, paste the console output here (especially the “SUCCESS:” line) and confirm the PNG looks like your primitives-with-wireframe modifier, not an arrow-plot.


{'asset_pointer': 'file-service://file-PZkhThXX9FxoZNPVJPUVDm', 'content_type': 'image_asset_pointer', 'fovea': None, 'height': 1350, 'metadata': {'asset_pointer_link': None, 'container_pixel_height': None, 'container_pixel_width': None, 'dalle': None, 'emu_omit_glimpse_image': None, 'emu_patches_override': None, 'generation': None, 'gizmo': None, 'is_no_auth_placeholder': None, 'lpe_delta_encoding_channel': None, 'lpe_keep_patch_ijhw': None, 'sanitized': True, 'watermarked_asset_pointer': None}, 'size_bytes': 1297557, 'width': 1080}
1) savded in /Users/timwhite/Documents


Mr. White, since your PNG landed in `/Users/timwhite/Documents`, let’s verify and re-run properly:

---

**1. Open the render**  
- In Finder → go to **Documents** → double-click **simple_human_wireframe.png**.  
- If you see arrows (the old plot) you still haven’t run your Blender script.

---

**2. Run your script from macOS Terminal**  
*(Not Blender’s Python console.)*  
1. Open Terminal (⌘ Space → “Terminal” → ↩).  
2. Change into Documents:  
   ```bash
   cd ~/Documents
   ```  
3. Launch Blender headless with your script:  
   ```bash
   "/Applications/Blender.app/Contents/MacOS/Blender" --background --python simple_human_wireframe.py
   ```  
4. Watch for a **SUCCESS:** message in Terminal.  

---

**3. Confirm the new render**  
- After it finishes, re-open **simple_human_wireframe.png** in Documents.  
- If you see your cube+sphere/cylinder humanoid with a wireframe, you’re done.  
- If not, copy & paste the Terminal output here so I can pinpoint what’s still going wrong.



Blender 4.4.3 (hash 802179c51ccc built 2025-04-29 14:25:11)
[INFO ] services.locationservice ...............: Not adding link to MakeHuman user data, since neither explicit path nor auto-discovery is set in preferences.
[INFO ] mpfb.init ..............................: Build info 20250419
[INFO ] mpfb.init ..............................: MPFB initialization has finished.
=== SIMPLE HUMAN WIREFRAME TEST ===
=== SETTING UP SCENE ===
=== TESTING MAKEHUMAN THOROUGHLY ===
MPFB addon found. Available operators:
  - bpy.ops.mpfb.add_corrective_smooth
  - bpy.ops.mpfb.add_helpers
  - bpy.ops.mpfb.add_rigify_rig
  - bpy.ops.mpfb.add_standard_rig
  - bpy.ops.mpfb.apply_pose
  - bpy.ops.mpfb.auto_transfer_weights
  - bpy.ops.mpfb.bake_shapekeys
  - bpy.ops.mpfb.basemesh_xref
  - bpy.ops.mpfb.boundingbox
  - bpy.ops.mpfb.check_makeclothes_clothes
  - bpy.ops.mpfb.convert_to_rigify
  - bpy.ops.mpfb.copy_connected_strategy
  - bpy.ops.mpfb.copy_pose
  - bpy.ops.mpfb.create_groups
  - bpy.ops.mpfb.create_human
  - bpy.ops.mpfb.create_ink
  - bpy.ops.mpfb.create_makeskin_material
  - bpy.ops.mpfb.create_maketarget_target
  - bpy.ops.mpfb.create_uv_map
  - bpy.ops.mpfb.create_v2_skin
  - bpy.ops.mpfb.delete_helpers
  - bpy.ops.mpfb.destroy_groups
  - bpy.ops.mpfb.dir_resource
  - bpy.ops.mpfb.enhancedsettings_apply_settings
  - bpy.ops.mpfb.export_log
  - bpy.ops.mpfb.extract_makeclothes_clothes
  - bpy.ops.mpfb.eyesettings_apply_settings
  - bpy.ops.mpfb.generate_rigify_rig
  - bpy.ops.mpfb.genuuid
  - bpy.ops.mpfb.human_from_mhm
  - bpy.ops.mpfb.human_from_presets
  - bpy.ops.mpfb.import_makeskin_material
  - bpy.ops.mpfb.import_maketarget_ptarget
  - bpy.ops.mpfb.import_maketarget_target
  - bpy.ops.mpfb.import_makeweight_weight
  - bpy.ops.mpfb.import_uv_map
  - bpy.ops.mpfb.importer_import_body
  - bpy.ops.mpfb.importerpresets_load_importer_presets
  - bpy.ops.mpfb.importerpresets_overwrite_importer_presets
  - bpy.ops.mpfb.importerpresets_save_new_importer_presets
  - bpy.ops.mpfb.install_target
  - bpy.ops.mpfb.legacy_makeclothes_import
  - bpy.ops.mpfb.list_log_levels
  - bpy.ops.mpfb.load_animation
  - bpy.ops.mpfb.load_clothes
  - bpy.ops.mpfb.load_library_clothes
  - bpy.ops.mpfb.load_library_ink
  - bpy.ops.mpfb.load_library_material
  - bpy.ops.mpfb.load_library_pose
  - bpy.ops.mpfb.load_library_proxy
  - bpy.ops.mpfb.load_library_skin
  - bpy.ops.mpfb.load_makeup_presets
  - bpy.ops.mpfb.load_mhbvh_pose
  - bpy.ops.mpfb.load_nodes
  - bpy.ops.mpfb.load_pack
  - bpy.ops.mpfb.load_partial
  - bpy.ops.mpfb.load_pose
  - bpy.ops.mpfb.load_rig
  - bpy.ops.mpfb.load_target
  - bpy.ops.mpfb.load_walk_cycle
  - bpy.ops.mpfb.load_weights
  - bpy.ops.mpfb.make_cyclic
  - bpy.ops.mpfb.makeclothes_gendelete
  - bpy.ops.mpfb.map_mixamo
  - bpy.ops.mpfb.mark_makeclothes_clothes
  - bpy.ops.mpfb.move_bone_to_cube
  - bpy.ops.mpfb.overwrite_enhanced_settings
  - bpy.ops.mpfb.overwrite_eye_settings
  - bpy.ops.mpfb.overwrite_human_presets
  - bpy.ops.mpfb.overwrite_makeup_presets
  - bpy.ops.mpfb.print_maketarget_target
  - bpy.ops.mpfb.prune_human
  - bpy.ops.mpfb.reapply_strategy
  - bpy.ops.mpfb.reduced_doll
  - bpy.ops.mpfb.refit_human
  - bpy.ops.mpfb.remove_helpers
  - bpy.ops.mpfb.remove_makeup
  - bpy.ops.mpfb.repeat_animation
  - bpy.ops.mpfb.replace_with_skin
  - bpy.ops.mpfb.reset_log_levels
  - bpy.ops.mpfb.rewrite_node_types
  - bpy.ops.mpfb.save_animation
  - bpy.ops.mpfb.save_makeweight_weight
  - bpy.ops.mpfb.save_new_enhanced_settings
  - bpy.ops.mpfb.save_new_eye_settings
  - bpy.ops.mpfb.save_new_human_presets
  - bpy.ops.mpfb.save_new_makeup_presets
  - bpy.ops.mpfb.save_nodes
  - bpy.ops.mpfb.save_openpose
  - bpy.ops.mpfb.save_pose
  - bpy.ops.mpfb.save_rig
  - bpy.ops.mpfb.save_strategy_vertices
  - bpy.ops.mpfb.save_target
  - bpy.ops.mpfb.save_weights
  - bpy.ops.mpfb.set_bone_end_offset
  - bpy.ops.mpfb.set_bone_end_strategy
  - bpy.ops.mpfb.set_log_level
  - bpy.ops.mpfb.set_normalmap
  - bpy.ops.mpfb.set_roll_strategy
  - bpy.ops.mpfb.setup_sculpt
  - bpy.ops.mpfb.show_strategy_vertices
  - bpy.ops.mpfb.symmetrize_maketarget_left
  - bpy.ops.mpfb.symmetrize_maketarget_right
  - bpy.ops.mpfb.symmetrize_makeweight_left
  - bpy.ops.mpfb.symmetrize_makeweight_right
  - bpy.ops.mpfb.truncate_weights
  - bpy.ops.mpfb.unit_tests
  - bpy.ops.mpfb.unload_library_clothes
  - bpy.ops.mpfb.web_resource
  - bpy.ops.mpfb.write_alternate
  - bpy.ops.mpfb.write_composite
  - bpy.ops.mpfb.write_ink_layer
  - bpy.ops.mpfb.write_library_target
  - bpy.ops.mpfb.write_makeclothes_clothes
  - bpy.ops.mpfb.write_makeclothes_library
  - bpy.ops.mpfb.write_makeskin_material
  - bpy.ops.mpfb.write_makeskin_to_library
  - bpy.ops.mpfb.write_maketarget_ptarget
  - bpy.ops.mpfb.write_maketarget_target
  - bpy.ops.mpfb.write_material
  - bpy.ops.mpfb.write_uv_map

Trying: bpy.ops.mpfb.create_character()
✗ create_character failed: Calling operator "bpy.ops.mpfb.create_character" error, could not be found

Trying: bpy.ops.mpfb.import_body()
✗ import_body failed: Calling operator "bpy.ops.mpfb.import_body" error, could not be found

Trying: bpy.ops.mpfb.load_human()
✗ load_human failed: Calling operator "bpy.ops.mpfb.load_human" error, could not be found

Trying: bpy.ops.mpfb.new_human()
✗ new_human failed: Calling operator "bpy.ops.mpfb.new_human" error, could not be found

Trying: bpy.ops.mpfb.add_human()
✗ add_human failed: Calling operator "bpy.ops.mpfb.add_human" error, could not be found
✗ All MakeHuman methods failed

MakeHuman failed, trying metaball approach...
=== CREATING METABALL HUMAN ===
✓ Metaball human created: 244 vertices

=== DEBUGGING HUMAN: Metaball_Human ===
Type: MESH
Vertices: 244
Faces: 290
Location: <Vector (0.0000, 0.0000, 0.5000)>
Scale: <Vector (1.0000, 1.0000, 1.0000)>
Dimensions: <Vector (3.2543, 2.5802, 2.6104)>
Height range: -0.63 to 1.98
Modifiers: ['Subdivision']

Rendering human wireframe...
Fra:1 Mem:11.29M (Peak 11.29M) | Time:00:00.01 | Mem:0.00M, Peak:0.00M | Scene, ViewLayer | Synchronizing object | Metaball_Human
Fra:1 Mem:11.87M (Peak 11.87M) | Time:00:00.01 | Mem:0.00M, Peak:0.00M | Scene, ViewLayer | Initializing
Fra:1 Mem:11.13M (Peak 11.87M) | Time:00:00.01 | Mem:0.00M, Peak:0.00M | Scene, ViewLayer | Waiting for render to start
Fra:1 Mem:11.13M (Peak 11.87M) | Time:00:00.01 | Mem:0.00M, Peak:0.00M | Scene, ViewLayer | Loading render kernels (may take a few minutes the first time)
Fra:1 Mem:11.13M (Peak 11.87M) | Time:00:00.01 | Mem:0.00M, Peak:0.00M | Scene, ViewLayer | Updating Scene
Fra:1 Mem:11.13M (Peak 11.87M) | Time:00:00.01 | Mem:0.00M, Peak:0.00M | Scene, ViewLayer | Updating Shaders
Fra:1 Mem:11.22M (Peak 11.87M) | Time:00:00.01 | Mem:0.00M, Peak:0.00M | Scene, ViewLayer | Updating Procedurals
Fra:1 Mem:11.22M (Peak 11.87M) | Time:00:00.01 | Mem:0.00M, Peak:0.00M | Scene, ViewLayer | Updating Background
Fra:1 Mem:11.22M (Peak 11.87M) | Time:00:00.01 | Mem:0.00M, Peak:0.00M | Scene, ViewLayer | Updating Camera
Fra:1 Mem:11.22M (Peak 11.87M) | Time:00:00.01 | Mem:0.00M, Peak:0.00M | Scene, ViewLayer | Updating Meshes Flags
Fra:1 Mem:11.22M (Peak 11.87M) | Time:00:00.01 | Mem:0.00M, Peak:0.00M | Scene, ViewLayer | Updating Objects
Fra:1 Mem:11.22M (Peak 11.87M) | Time:00:00.01 | Mem:0.00M, Peak:0.00M | Scene, ViewLayer | Updating Objects | Copying Transformations to device
Fra:1 Mem:11.22M (Peak 11.87M) | Time:00:00.01 | Mem:0.00M, Peak:0.00M | Scene, ViewLayer | Updating Objects | Applying Static Transformations
Fra:1 Mem:11.22M (Peak 11.87M) | Time:00:00.01 | Mem:0.00M, Peak:0.00M | Scene, ViewLayer | Updating Particle Systems
Fra:1 Mem:11.22M (Peak 11.87M) | Time:00:00.01 | Mem:0.00M, Peak:0.00M | Scene, ViewLayer | Updating Particle Systems | Copying Particles to device
Fra:1 Mem:11.22M (Peak 11.87M) | Time:00:00.01 | Mem:0.00M, Peak:0.00M | Scene, ViewLayer | Updating Meshes
Fra:1 Mem:11.35M (Peak 11.87M) | Time:00:00.01 | Mem:0.00M, Peak:0.00M | Scene, ViewLayer | Updating Mesh | Computing attributes
Fra:1 Mem:11.35M (Peak 11.87M) | Time:00:00.01 | Mem:0.00M, Peak:0.00M | Scene, ViewLayer | Updating Mesh | Copying Attributes to device
Fra:1 Mem:11.35M (Peak 11.87M) | Time:00:00.01 | Mem:0.00M, Peak:0.00M | Scene, ViewLayer | Updating Scene BVH | Building
Fra:1 Mem:11.35M (Peak 11.87M) | Time:00:00.01 | Mem:0.00M, Peak:0.00M | Scene, ViewLayer | Updating Scene BVH | Building BVH
Fra:1 Mem:11.35M (Peak 11.87M) | Time:00:00.01 | Mem:0.26M, Peak:0.26M | Scene, ViewLayer | Updating Scene BVH | Building BVH 0%
Fra:1 Mem:11.35M (Peak 11.87M) | Time:00:00.01 | Mem:0.58M, Peak:0.84M | Scene, ViewLayer | Updating Scene BVH | Copying BVH to device
Fra:1 Mem:11.35M (Peak 11.87M) | Time:00:00.01 | Mem:0.58M, Peak:0.84M | Scene, ViewLayer | Updating Mesh | Computing normals
Fra:1 Mem:11.64M (Peak 11.87M) | Time:00:00.01 | Mem:0.58M, Peak:0.84M | Scene, ViewLayer | Updating Mesh | Copying Mesh to device
Fra:1 Mem:11.64M (Peak 11.87M) | Time:00:00.01 | Mem:0.87M, Peak:0.87M | Scene, ViewLayer | Updating Objects Flags
Fra:1 Mem:11.64M (Peak 11.87M) | Time:00:00.01 | Mem:0.87M, Peak:0.87M | Scene, ViewLayer | Updating Primitive Offsets
Fra:1 Mem:11.64M (Peak 11.87M) | Time:00:00.01 | Mem:0.87M, Peak:0.87M | Scene, ViewLayer | Updating Images
Fra:1 Mem:11.64M (Peak 11.87M) | Time:00:00.01 | Mem:0.87M, Peak:0.87M | Scene, ViewLayer | Updating Camera Volume
Fra:1 Mem:11.64M (Peak 11.87M) | Time:00:00.01 | Mem:0.87M, Peak:0.87M | Scene, ViewLayer | Updating Lookup Tables
Fra:1 Mem:11.64M (Peak 11.87M) | Time:00:00.01 | Mem:0.95M, Peak:0.95M | Scene, ViewLayer | Updating Lights
Fra:1 Mem:11.64M (Peak 11.87M) | Time:00:00.01 | Mem:0.95M, Peak:0.95M | Scene, ViewLayer | Updating Lights | Computing tree
Fra:1 Mem:13.23M (Peak 14.27M) | Time:00:00.03 | Mem:2.54M, Peak:2.54M | Scene, ViewLayer | Updating Integrator
Fra:1 Mem:13.23M (Peak 14.27M) | Time:00:00.03 | Mem:2.54M, Peak:2.54M | Scene, ViewLayer | Updating Film
Fra:1 Mem:13.23M (Peak 14.27M) | Time:00:00.03 | Mem:2.46M, Peak:2.54M | Scene, ViewLayer | Updating Lookup Tables
Fra:1 Mem:13.23M (Peak 14.27M) | Time:00:00.03 | Mem:2.54M, Peak:2.54M | Scene, ViewLayer | Updating Baking
Fra:1 Mem:13.23M (Peak 14.27M) | Time:00:00.03 | Mem:2.54M, Peak:2.54M | Scene, ViewLayer | Updating Device | Writing constant memory
Fra:1 Mem:13.23M (Peak 14.27M) | Time:00:00.03 | Mem:2.54M, Peak:2.54M | Scene, ViewLayer | Loading denoising kernels (may take a few minutes the first time)
Fra:1 Mem:13.23M (Peak 14.27M) | Time:00:00.03 | Mem:2.54M, Peak:2.54M | Scene, ViewLayer | Sample 0/32
Fra:1 Mem:118.99M (Peak 118.99M) | Time:00:00.17 | Remaining:00:04.48 | Mem:108.22M, Peak:108.22M | Scene, ViewLayer | Sample 1/32
Fra:1 Mem:163.49M (Peak 230.23M) | Time:00:06.98 | Mem:108.22M, Peak:108.22M | Scene, ViewLayer | Sample 32/32
Fra:1 Mem:163.49M (Peak 230.23M) | Time:00:06.98 | Mem:108.22M, Peak:108.22M | Scene, ViewLayer | Finished
Saved: '/Users/timwhite/Documents/simple_human_wireframe.png'
Time: 00:07.11 (Saving: 00:00.12)

✓ SUCCESS: /Users/timwhite/Documents/simple_human_wireframe.png
Check if this looks more human-like!

Blender quit
timwhite@Tims-Air Documents % 



1. **Verify the render file**  
   In Terminal (you’re already in `~/Documents`), run:  
   ```bash
   ls -l simple_human_wireframe.png
   open simple_human_wireframe.png
   ```  
   That will show the file’s timestamp and open it in Preview. If it shows your metaball-blob with wireframe, the script worked.

2. **Force the cube+sphere primitive fallback**  
   Right now you got the metaball result (244 verts). To see the blocky human shape, edit the bottom of your script (`main()`):  
   ```python
   # Replace these lines:
   human = test_makehuman_thoroughly()
   if not human:
       human = create_metaball_human()
   # …
   ```  
   with this:
   ```python
   human = None
   human = create_simple_human_shape()
   ```  
   (Comment out the MakeHuman and metaball calls.)

3. **Re-run headless**  
   ```bash
   "/Applications/Blender.app/Contents/MacOS/Blender" --background --python simple_human_wireframe.py
   open simple_human_wireframe.png
   ```  
   Now you should see your cube torso, sphere head and cylinder arms in wireframe.

4. **Adjust thickness if needed**  
   In `create_simple_human_shape()` you can tweak the wireframe thickness modifier:  
   ```python
   obj.modifiers["Wireframe"].thickness = 0.02  # try 0.01–0.05
   ```
   then rerun and reopen.


Give me the full new script


Here’s a slimmed-down version that skips MakeHuman and metaballs entirely and always builds your cube + sphere + cylinder “man” with a true wireframe material. Save this as `simple_human_wireframe.py` and run it the same way you did before.

```python
import bpy
import math
import os
from mathutils import Vector

def clear_scene():
    """Remove all objects and return to OBJECT mode."""
    if bpy.context.mode != 'OBJECT':
        bpy.ops.object.mode_set(mode='OBJECT')
    bpy.ops.object.select_all(action='SELECT')
    bpy.ops.object.delete(use_global=False)

def create_simple_human_shape():
    """Create a blocky human: torso (cube), head (sphere), arms (cylinders)."""
    print("=== CREATING SIMPLE HUMAN SHAPE ===")
    # Torso
    bpy.ops.mesh.primitive_cube_add(size=1, location=(0, 0, 0.5))
    torso = bpy.context.object
    torso.name = "Human_Torso"
    torso.scale = (0.6, 0.3, 1.2)
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)

    # Head
    bpy.ops.mesh.primitive_uv_sphere_add(radius=0.25, location=(0, 0, 1.4))
    head = bpy.context.object
    head.name = "Human_Head"

    # Left arm
    bpy.ops.mesh.primitive_cylinder_add(
        radius=0.08, depth=0.8,
        location=(-0.5, 0, 0.8),
        rotation=(0, 0, math.radians(-20))
    )
    left_arm = bpy.context.object
    left_arm.name = "Human_LeftArm"

    # Right arm
    bpy.ops.mesh.primitive_cylinder_add(
        radius=0.08, depth=0.8,
        location=(0.5, 0, 0.8),
        rotation=(0, 0, math.radians(20))
    )
    right_arm = bpy.context.object
    right_arm.name = "Human_RightArm"

    # Join into one mesh
    bpy.ops.object.select_all(action='DESELECT')
    for obj in (torso, head, left_arm, right_arm):
        obj.select_set(True)
    bpy.context.view_layer.objects.active = torso
    bpy.ops.object.join()
    return torso

def setup_scene():
    """Configure camera, lighting, background, and render settings."""
    scene = bpy.context.scene
    scene.render.engine = 'CYCLES'
    scene.render.resolution_x = 1080
    scene.render.resolution_y = 1350
    scene.cycles.samples = 32

    # Camera
    bpy.ops.object.camera_add(location=(0, -3, 1))
    cam = bpy.context.object
    cam.rotation_euler = (math.radians(75), 0, 0)
    cam.data.lens = 50
    scene.camera = cam

    # Sun light
    bpy.ops.object.light_add(type='SUN', location=(2, -2, 4))
    sun = bpy.context.object
    sun.data.energy = 20

    # Black world background
    world = scene.world or bpy.data.worlds.new("World")
    scene.world = world
    world.use_nodes = True
    nt = world.node_tree
    nt.nodes.clear()
    bg = nt.nodes.new('ShaderNodeBackground')
    bg.inputs[0].default_value = (0,0,0,1)
    bg.inputs[1].default_value = 0
    out = nt.nodes.new('ShaderNodeOutputWorld')
    nt.links.new(bg.outputs[0], out.inputs[0])

def create_wireframe_material():
    """White emission on a transparent base, masked by a wireframe node."""
    mat = bpy.data.materials.new("Simple_Wireframe")
    mat.use_nodes = True
    nodes = mat.node_tree.nodes
    links = mat.node_tree.links
    nodes.clear()

    wire = nodes.new('ShaderNodeWireframe')
    wire.inputs[0].default_value = 0.008

    emit = nodes.new('ShaderNodeEmission')
    emit.inputs[0].default_value = (1,1,1,1)
    emit.inputs[1].default_value = 8.0

    transp = nodes.new('ShaderNodeBsdfTransparent')
    mix = nodes.new('ShaderNodeMixShader')
    out = nodes.new('ShaderNodeOutputMaterial')

    links.new(wire.outputs[0], mix.inputs[0])
    links.new(emit.outputs[0], mix.inputs[1])
    links.new(transp.outputs[0], mix.inputs[2])
    links.new(mix.outputs[0], out.inputs[0])

    return mat

def debug_human(human):
    """Log basic info about the created mesh."""
    print(f"\n=== DEBUGGING HUMAN: {human.name} ===")
    print(f"Verts: {len(human.data.vertices)}, Faces: {len(human.data.polygons)}")
    bbox = [human.matrix_world @ Vector(c) for c in human.bound_box]
    zmin, zmax = min(v.z for v in bbox), max(v.z for v in bbox)
    print(f"Height: {zmin:.2f} → {zmax:.2f}")

def main():
    print("=== SIMPLE HUMAN WIREFRAME TEST (PRIMITIVE ONLY) ===")
    clear_scene()
    setup_scene()

    human = create_simple_human_shape()
    debug_human(human)

    # Apply wireframe material
    wf_mat = create_wireframe_material()
    human.data.materials.clear()
    human.data.materials.append(wf_mat)

    # Render out
    out = "/Users/timwhite/Documents/simple_human_wireframe.png"
    bpy.context.scene.render.filepath = out
    print(f"\nRendering to {out} …")
    bpy.ops.render.render(write_still=True)

    if os.path.exists(out):
        print(f"✓ SUCCESS: {out}")
    else:
        print("✗ Render failed")

if __name__ == "__main__":
    main()
```

**Usage (in Terminal):**  
```bash
cd ~/Documents
"/Applications/Blender.app/Contents/MacOS/Blender" \
  --background --python simple_human_wireframe.py
open simple_human_wireframe.png
```


{'asset_pointer': 'file-service://file-E7cytd5bp8dzmyambuxg8s', 'content_type': 'image_asset_pointer', 'fovea': None, 'height': 1350, 'metadata': {'asset_pointer_link': None, 'container_pixel_height': None, 'container_pixel_width': None, 'dalle': None, 'emu_omit_glimpse_image': None, 'emu_patches_override': None, 'generation': None, 'gizmo': None, 'is_no_auth_placeholder': None, 'lpe_delta_encoding_channel': None, 'lpe_keep_patch_ijhw': None, 'sanitized': True, 'watermarked_asset_pointer': None}, 'size_bytes': 998626, 'width': 1080}
Ok that's more human looking but we need it way more hman looking


Here’s a one-file script that always builds a full blocky human (torso, head, arms, legs), subdivides for smoothness, then applies your wireframe material. Save as `simple_human_wireframe.py` and run headless exactly as before.

```python
import bpy
import math
import os
from mathutils import Vector

def clear_scene():
    if bpy.context.mode != 'OBJECT':
        bpy.ops.object.mode_set(mode='OBJECT')
    bpy.ops.object.select_all(action='SELECT')
    bpy.ops.object.delete(use_global=False)

def create_human_primitives():
    # Torso
    bpy.ops.mesh.primitive_cube_add(size=1, location=(0, 0, 0.6))
    torso = bpy.context.object
    torso.scale = (0.6, 0.3, 1.0)
    bpy.ops.object.transform_apply(scale=True)

    # Head
    bpy.ops.mesh.primitive_uv_sphere_add(radius=0.25, location=(0, 0, 2.0))
    head = bpy.context.object

    # Arms
    for x, rot in [(-0.6, -20), (0.6, 20)]:
        bpy.ops.mesh.primitive_cylinder_add(
            radius=0.08, depth=0.8,
            location=(x, 0, 1.2),
            rotation=(0, 0, math.radians(rot))
        )

    # Legs
    for x in (-0.2, 0.2):
        bpy.ops.mesh.primitive_cylinder_add(
            radius=0.1, depth=1.2,
            location=(x, 0, -0.0)
        )

    # Join all
    objs = bpy.context.scene.objects
    prims = [o for o in objs if o.name.startswith(("Cube","Sphere","Cylinder"))]
    for o in prims:
        o.select_set(True)
    bpy.context.view_layer.objects.active = prims[0]
    bpy.ops.object.join()
    prims[0].name = "Human"
    return prims[0]

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

    # Light
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

def create_wire_material():
    mat = bpy.data.materials.new("WireMat")
    mat.use_nodes = True
    nodes = mat.node_tree.nodes; links = mat.node_tree.links
    nodes.clear()
    w = nodes.new('ShaderNodeWireframe'); w.inputs[0].default_value=0.005
    e = nodes.new('ShaderNodeEmission'); e.inputs[1].default_value=10
    t = nodes.new('ShaderNodeBsdfTransparent')
    m = nodes.new('ShaderNodeMixShader')
    o = nodes.new('ShaderNodeOutputMaterial')
    links.new(w.outputs[0], m.inputs[0])
    links.new(e.outputs[0], m.inputs[1])
    links.new(t.outputs[0], m.inputs[2])
    links.new(m.outputs[0], o.inputs[0])
    return mat

def main():
    print("=== FULL HUMAN WIREFRAME ===")
    clear_scene()
    setup_scene()
    human = create_human_primitives()

    # Smooth
    bpy.ops.object.modifier_add(type='SUBSURF')
    human.modifiers[-1].levels = 3

    # Wireframe material
    mat = create_wire_material()
    human.data.materials.clear()
    human.data.materials.append(mat)

    # Render
    out = "/Users/timwhite/Documents/simple_human_wireframe.png"
    bpy.context.scene.render.filepath = out
    bpy.ops.render.render(write_still=True)
    if os.path.exists(out):
        print("✓ Rendered:", out)
    else:
        print("✗ Failed to save")

if __name__=="__main__":
    main()
```

**Run it**  
```bash
cd ~/Documents
"/Applications/Blender.app/Contents/MacOS/Blender" \
  --background --python simple_human_wireframe.py
open simple_human_wireframe.png
```

You should now see a full-body humanoid silhouette with smooth topology and crisp wireframe.


{'asset_pointer': 'file-service://file-Cg6H4VNWtpVYwyJRr7VMHC', 'content_type': 'image_asset_pointer', 'fovea': None, 'height': 1350, 'metadata': {'asset_pointer_link': None, 'container_pixel_height': None, 'container_pixel_width': None, 'dalle': None, 'emu_omit_glimpse_image': None, 'emu_patches_override': None, 'generation': None, 'gizmo': None, 'is_no_auth_placeholder': None, 'lpe_delta_encoding_channel': None, 'lpe_keep_patch_ijhw': None, 'sanitized': True, 'watermarked_asset_pointer': None}, 'size_bytes': 795925, 'width': 1080}
Ok lets use makehumn to make this look more real

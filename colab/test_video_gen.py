import os
import sys
import time
sys.path.append("/content")
import minimax_engine

print("=== STARTING MINIMAX-H3 VIDEO GENERATION TEST ===")
t0 = time.time()

prompt = "The female anchor smiles looking at the camera, lifts the bottle with her right hand, and gently nods."
first_frame = "/content/ComfyUI/output/actor_anchor_00001_.png"
out_video = "/content/test_video.mp4"

def progress_cb(pct, status, msg, extra=None):
    print(f"[{pct}%] [{status}] {msg}", flush=True)

try:
    minimax_engine.generate_video_clip(
        prompt=prompt,
        keyframe_path=first_frame,
        duration_sec=3.5,
        output_path=out_video,
        progress_callback=progress_cb
    )
    t1 = time.time()
    print(f"VIDEO_GENERATION_SUCCESS: {out_video}")
    print(f"Time taken: {t1 - t0:.2f} seconds")
    print(f"File size: {os.path.getsize(out_video)} bytes")
except Exception as e:
    import traceback
    traceback.print_exc()

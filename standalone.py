"""PyInstaller entry point — launches the desktop app or an audio worker."""
import multiprocessing

if __name__ == "__main__":
    multiprocessing.freeze_support()
    from rs_studio.desktop import launch

    launch()

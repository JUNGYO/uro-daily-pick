"""Process-safe two-request admission for the existing literature inference service.

The historical byte-zero lock remains the exclusive research/old-worker lock.
Summaries share it, with two additional exclusive slot locks. A waiting exclusive
client owns the admission gate so a stream of summaries cannot starve it.
"""
from contextlib import contextmanager, ExitStack
import os
from pathlib import Path
import time


if os.name == "nt":
    import ctypes
    from ctypes import wintypes
    import msvcrt

    class _Overlapped(ctypes.Structure):
        _fields_ = [("Internal", ctypes.c_size_t), ("InternalHigh", ctypes.c_size_t),
                    ("Offset", wintypes.DWORD), ("OffsetHigh", wintypes.DWORD),
                    ("hEvent", wintypes.HANDLE)]

    _kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    _kernel.LockFileEx.argtypes = [wintypes.HANDLE, wintypes.DWORD, wintypes.DWORD,
                                  wintypes.DWORD, wintypes.DWORD, ctypes.POINTER(_Overlapped)]
    _kernel.LockFileEx.restype = wintypes.BOOL
    _kernel.UnlockFileEx.argtypes = [wintypes.HANDLE, wintypes.DWORD, wintypes.DWORD,
                                    wintypes.DWORD, ctypes.POINTER(_Overlapped)]
    _kernel.UnlockFileEx.restype = wintypes.BOOL


def _try_lock(handle, shared=False):
    if os.name == "nt":
        operation = _Overlapped()
        if _kernel.LockFileEx(msvcrt.get_osfhandle(handle.fileno()),
                              1 | (0 if shared else 2), 0, 1, 0, ctypes.byref(operation)):
            return True
        code = ctypes.get_last_error()
        if code in (32, 33):
            return False
        raise ctypes.WinError(code)
    import fcntl
    try:
        fcntl.flock(handle.fileno(), (fcntl.LOCK_SH if shared else fcntl.LOCK_EX) | fcntl.LOCK_NB)
        return True
    except BlockingIOError:
        return False


def _unlock(handle):
    if os.name == "nt":
        operation = _Overlapped()
        if not _kernel.UnlockFileEx(msvcrt.get_osfhandle(handle.fileno()), 0, 1, 0, ctypes.byref(operation)):
            raise ctypes.WinError(ctypes.get_last_error())
    else:
        import fcntl
        fcntl.flock(handle.fileno(), fcntl.LOCK_UN)


def _open(root, name):
    path = root / name
    if path.resolve().parent != root:
        raise ValueError("Inference locks must remain in the literature state directory")
    return path.open("a+b")


def _pause(deadline, remaining):
    time.sleep(remaining(deadline, 0.1))


@contextmanager
def inference_access(directory, deadline, remaining, *, shared=False):
    root = Path(directory).resolve()
    # All handles are separate open-file descriptions, including between threads.
    with ExitStack() as stack:
        gate = stack.enter_context(_open(root, "literature-inference-admission.lock"))
        common = stack.enter_context(_open(root, "literature-inference.lock"))
        if shared:
            slots = [stack.enter_context(_open(root, f"literature-inference-slot-{i}.lock")) for i in range(2)]
            selected = None
            while selected is None:
                remaining(deadline)
                selected = next((handle for handle in slots if _try_lock(handle)), None)
                if selected is None:
                    _pause(deadline, remaining)
            stack.callback(_unlock, selected)
            while True:
                remaining(deadline)
                if _try_lock(gate):
                    try:
                        admitted = _try_lock(common, shared=True)
                    finally:
                        _unlock(gate)
                    if admitted:
                        break
                _pause(deadline, remaining)
        else:
            # Holding the gate while draining shared readers gives research priority.
            while not _try_lock(gate):
                _pause(deadline, remaining)
            try:
                remaining(deadline)
                while not _try_lock(common):
                    _pause(deadline, remaining)
            finally:
                _unlock(gate)
        stack.callback(_unlock, common)
        yield

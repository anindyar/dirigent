# OpenClaw-ACC — Fork Implementation Specification

## Overview

This document specifies exactly what is added to and changed in the OpenClaw codebase to produce the **OpenClaw-ACC** fork. The philosophy is minimal invasiveness: add the ACC kernel module, patch two files, add a config schema. The core model runner, chat loop, and context manager are untouched.

---

## Fork Strategy

```
upstream: openclaw/openclaw (latest stable)
fork:     techimbue/openclaw-acc

Changes:
  ADD     openclaw/acc_kernel/          ← new package (~400 lines total)
  PATCH   openclaw/plugin_loader.py     ← 18 lines changed
  PATCH   openclaw/tool_executor.py     ← 42 lines changed
  ADD     acc_config.yaml.example
  ADD     openclaw/acc_meta_endpoint.py ← /acc/meta HTTP endpoint for discovery
```

Maintain upstream as a remote. Pull upstream changes regularly and rebase. The kernel package and two patches should have minimal conflict surface.

---

## New Package: `openclaw/acc_kernel/`

### `__init__.py`

```python
from .kernel import ACCKernel
from .config import ACCConfig
from .relay import ToolRelayInterceptor

__all__ = ["ACCKernel", "ACCConfig", "ToolRelayInterceptor"]
```

---

### `config.py`

```python
import os
import yaml
from pathlib import Path
from dataclasses import dataclass, field
from typing import Optional


@dataclass
class ACCConfig:
    acc_server: str                         # wss://acc.techimbue.internal:9443
    agent_id: str                           # AEGIS-05
    api_key: str                            # raw key (sent in WS header, never logged)
    cert_path: Optional[str] = None         # path to agent client cert (.pem)
    key_path: Optional[str] = None          # path to agent private key (.pem)
    ca_cert_path: Optional[str] = None      # path to ACC CA cert for server verification
    acc_public_key_path: Optional[str] = None  # ACC RSA public key for manifest verification
    heartbeat_interval: int = 10            # seconds
    reconnect_attempts: int = 3
    reconnect_backoff_base: float = 2.0     # exponential backoff base
    manifest_ttl_warn_seconds: int = 300    # warn X seconds before manifest expiry
    mdns_announce: bool = True              # broadcast _agent._tcp.local on startup
    mdns_service_name: str = ""             # auto-filled from agent_id if empty
    log_tool_calls: bool = True
    log_level: str = "INFO"

    @classmethod
    def from_file(cls, path: str = None) -> "ACCConfig":
        """
        Load config from YAML file.
        Search order:
          1. Explicit path argument
          2. ACC_CONFIG_PATH environment variable
          3. ~/.openclaw-acc/config.yaml
          4. /etc/openclaw-acc/config.yaml
        """
        search_paths = [
            path,
            os.environ.get("ACC_CONFIG_PATH"),
            str(Path.home() / ".openclaw-acc" / "config.yaml"),
            "/etc/openclaw-acc/config.yaml"
        ]

        for p in search_paths:
            if p and Path(p).exists():
                with open(p) as f:
                    data = yaml.safe_load(f)
                return cls(**{k: v for k, v in data.items() if k in cls.__dataclass_fields__})

        raise FileNotFoundError(
            "ACC config not found. Create ~/.openclaw-acc/config.yaml "
            "or set ACC_CONFIG_PATH. See acc_config.yaml.example."
        )

    def validate(self):
        assert self.acc_server.startswith("wss://"), "acc_server must use wss://"
        assert self.agent_id, "agent_id is required"
        assert self.api_key, "api_key is required"
        if self.cert_path:
            assert Path(self.cert_path).exists(), f"cert_path not found: {self.cert_path}"
        if self.ca_cert_path:
            assert Path(self.ca_cert_path).exists(), f"ca_cert_path not found: {self.ca_cert_path}"
```

---

### `kernel.py`

```python
import asyncio
import json
import logging
import ssl
import base64
import hashlib
import time
from datetime import datetime
from typing import Optional, Dict, Any
import websockets
from .config import ACCConfig

logger = logging.getLogger("acc_kernel")


class ACCKernel:
    """
    The ACC kernel is the first thing that starts in OpenClaw-ACC and the last
    thing that shuts down. It owns:
      - WSS connection to ACC server (with mTLS)
      - Registration handshake
      - Manifest reception and verification
      - Heartbeat loop
      - Kill switch listener
      - Live manifest refresh
    
    The plugin loader and tool executor are BLOCKED until the kernel
    has successfully registered and received a manifest.
    """

    def __init__(self, config: ACCConfig):
        self.config = config
        self.config.validate()

        self._ws: Optional[websockets.WebSocketClientProtocol] = None
        self._session_id: Optional[str] = None
        self._manifest: Optional[Dict] = None
        self._manifest_version: int = 0
        self._manifest_received = asyncio.Event()
        self._shutdown = asyncio.Event()
        self._connected = asyncio.Event()
        self._stats = {
            "calls_total": 0,
            "calls_blocked": 0,
            "start_time": time.time()
        }
        self._acc_public_key: Optional[bytes] = None
        if config.acc_public_key_path:
            with open(config.acc_public_key_path, "rb") as f:
                self._acc_public_key = f.read()

    # ------------------------------------------------------------------ #
    #  STARTUP — called before plugin loader                              #
    # ------------------------------------------------------------------ #

    async def start(self):
        """
        Blocking startup sequence. Returns only when manifest is received.
        Called by OpenClaw main() before anything else initialises.
        """
        logger.info(f"ACC kernel starting · agent={self.config.agent_id}")

        # Start mDNS announcement in background if configured
        if self.config.mdns_announce:
            asyncio.create_task(self._mdns_announce())

        # Connect with retry
        for attempt in range(self.config.reconnect_attempts):
            try:
                await self._connect()
                break
            except Exception as e:
                wait = self.config.reconnect_backoff_base ** attempt
                logger.warning(f"ACC connect attempt {attempt+1} failed: {e} · retry in {wait}s")
                if attempt == self.config.reconnect_attempts - 1:
                    raise RuntimeError(
                        f"Could not connect to ACC server at {self.config.acc_server} "
                        f"after {self.config.reconnect_attempts} attempts. Refusing to start."
                    )
                await asyncio.sleep(wait)

        # Block until manifest received (with timeout)
        try:
            await asyncio.wait_for(self._manifest_received.wait(), timeout=30.0)
        except asyncio.TimeoutError:
            raise RuntimeError("Timed out waiting for tool manifest from ACC. Refusing to start.")

        logger.info(
            f"ACC kernel ready · session={self._session_id} · "
            f"tools={len(self._manifest.get('tools', []))} · "
            f"manifest_version={self._manifest_version}"
        )

        # Start background loops
        asyncio.create_task(self._heartbeat_loop())
        asyncio.create_task(self._reconnect_watch())

    async def _connect(self):
        ssl_ctx = self._build_ssl_context()
        uri = f"{self.config.acc_server}/ws/agent/{self.config.agent_id}"

        self._ws = await websockets.connect(
            uri,
            ssl=ssl_ctx,
            extra_headers={"X-Agent-API-Key": self.config.api_key},
            ping_interval=20,
            ping_timeout=10,
            close_timeout=5
        )
        self._connected.set()
        asyncio.create_task(self._listen())

        # Send registration
        await self._send({
            "type": "REGISTER",
            "payload": {
                "agent_id": self.config.agent_id,
                "host": self._get_local_ip(),
                "acc_kernel_version": "1.0.0",
                "signature": self._sign_registration()
            }
        })

    def _build_ssl_context(self) -> ssl.SSLContext:
        ctx = ssl.create_default_context(ssl.Purpose.SERVER_AUTH)
        if self.config.ca_cert_path:
            ctx.load_verify_locations(self.config.ca_cert_path)
        else:
            ctx.check_hostname = False
            ctx.verify_mode = ssl.CERT_NONE
            logger.warning("No CA cert configured — TLS server verification disabled")
        if self.config.cert_path and self.config.key_path:
            ctx.load_cert_chain(self.config.cert_path, self.config.key_path)
        return ctx

    # ------------------------------------------------------------------ #
    #  MESSAGE HANDLING                                                   #
    # ------------------------------------------------------------------ #

    async def _listen(self):
        try:
            async for raw in self._ws:
                msg = json.loads(raw)
                await self._handle(msg)
        except websockets.ConnectionClosed:
            logger.warning("ACC connection closed")
            self._connected.clear()

    async def _handle(self, msg: dict):
        t = msg.get("type")

        if t == "REGISTER_ACK":
            self._session_id = msg["payload"].get("session_id")
            logger.info(f"Registered · session={self._session_id}")

        elif t == "MANIFEST":
            await self._receive_manifest(msg["payload"])

        elif t == "HEARTBEAT_ACK":
            pass  # normal, no action

        elif t == "CONFIG_UPDATE":
            self._apply_config_update(msg["payload"])

        elif t == "PAUSE":
            logger.warning(f"ACC PAUSE received: {msg['payload'].get('reason')}")
            # Set a flag that relay checks before tool execution
            self._paused = True
            resume_at = msg["payload"].get("resume_at")
            if resume_at:
                asyncio.create_task(self._auto_resume(resume_at))

        elif t == "KILL":
            grace = msg["payload"].get("grace_seconds", 5)
            reason = msg["payload"].get("reason", "ACC kill signal")
            logger.critical(f"ACC KILL received: {reason} · shutting down in {grace}s")
            await asyncio.sleep(grace)
            self._shutdown.set()
            raise SystemExit(0)

        else:
            logger.debug(f"Unknown ACC message type: {t}")

    async def _receive_manifest(self, payload: dict):
        # Verify signature before accepting
        if self._acc_public_key:
            if not self._verify_manifest_signature(payload):
                logger.error("MANIFEST SIGNATURE INVALID — rejecting manifest")
                return

        self._manifest = payload
        self._manifest_version = payload.get("version", 0)
        self._manifest_received.set()
        logger.info(
            f"Manifest v{self._manifest_version} received · "
            f"{len(payload.get('tools', []))} tools granted"
        )

    def _verify_manifest_signature(self, manifest: dict) -> bool:
        from cryptography.hazmat.primitives import hashes, serialization
        from cryptography.hazmat.primitives.asymmetric import padding
        import base64

        sig_str = manifest.get("signature", "")
        if not sig_str.startswith("acc-rsa-256:"):
            return False
        try:
            sig = base64.b64decode(sig_str[12:])
            payload = {k: v for k, v in manifest.items() if k != "signature"}
            data = json.dumps(payload, sort_keys=True).encode()
            pub_key = serialization.load_pem_public_key(self._acc_public_key)
            pub_key.verify(sig, data, padding.PKCS1v15(), hashes.SHA256())
            return True
        except Exception as e:
            logger.error(f"Manifest signature verification failed: {e}")
            return False

    def _apply_config_update(self, payload: dict):
        tool_id = payload.get("tool_id")
        updated_scopes = payload.get("updated_scopes", {})
        if tool_id and self._manifest:
            for tool in self._manifest.get("tools", []):
                if tool["tool_id"] == tool_id:
                    tool["scopes"].update(updated_scopes)
                    logger.info(f"Live scope update applied: {tool_id} → {updated_scopes}")
                    break

    # ------------------------------------------------------------------ #
    #  HEARTBEAT                                                          #
    # ------------------------------------------------------------------ #

    async def _heartbeat_loop(self):
        while not self._shutdown.is_set():
            await asyncio.sleep(self.config.heartbeat_interval)
            if self._connected.is_set():
                try:
                    await self._send({
                        "type": "HEARTBEAT",
                        "payload": {
                            "agent_id": self.config.agent_id,
                            "status": "paused" if getattr(self, "_paused", False) else "active",
                            "uptime_seconds": int(time.time() - self._stats["start_time"]),
                            "calls_total": self._stats["calls_total"],
                            "calls_blocked": self._stats["calls_blocked"],
                            "manifest_version": self._manifest_version
                        }
                    })
                except Exception as e:
                    logger.warning(f"Heartbeat failed: {e}")

    # ------------------------------------------------------------------ #
    #  PUBLIC API (used by relay interceptor and plugin loader)           #
    # ------------------------------------------------------------------ #

    def get_active_manifest(self) -> Optional[dict]:
        """Return the current live manifest. None if not yet received."""
        return self._manifest

    def get_granted_tools(self) -> list:
        """Return list of tool dicts from active manifest."""
        if not self._manifest:
            return []
        return self._manifest.get("tools", [])

    def get_tool_grant(self, tool_id: str) -> Optional[dict]:
        """Return the grant for a specific tool, or None if not granted."""
        for tool in self.get_granted_tools():
            if tool["tool_id"] == tool_id:
                return tool
        return None

    def record_call(self, blocked: bool = False):
        self._stats["calls_total"] += 1
        if blocked:
            self._stats["calls_blocked"] += 1

    async def send_tool_log(self, event_type: str, payload: dict):
        await self._send({"type": event_type, "payload": payload})

    # ------------------------------------------------------------------ #
    #  HELPERS                                                            #
    # ------------------------------------------------------------------ #

    async def _send(self, msg: dict):
        if self._ws and self._connected.is_set():
            await self._ws.send(json.dumps(msg))

    def _get_local_ip(self) -> str:
        import socket
        try:
            s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            s.connect(("8.8.8.8", 80))
            return s.getsockname()[0]
        except Exception:
            return "127.0.0.1"

    def _sign_registration(self) -> str:
        """Simple HMAC-based registration signature using API key."""
        import hmac, hashlib
        data = f"{self.config.agent_id}:{int(time.time() // 60)}"
        return hmac.new(self.config.api_key.encode(), data.encode(), hashlib.sha256).hexdigest()

    async def _mdns_announce(self):
        """Announce this agent on _agent._tcp.local for network discovery."""
        try:
            from zeroconf.asyncio import AsyncZeroconf
            from zeroconf import ServiceInfo
            import socket
            aiozc = AsyncZeroconf()
            service_name = self.config.mdns_service_name or f"{self.config.agent_id}._agent._tcp.local."
            info = ServiceInfo(
                "_agent._tcp.local.",
                service_name,
                addresses=[socket.inet_aton(self._get_local_ip())],
                port=8080,
                properties={
                    b"agent_id": self.config.agent_id.encode(),
                    b"runtime": b"openclaw-acc",
                    b"version": b"1.0.0"
                }
            )
            await aiozc.async_register_service(info)
            logger.info(f"mDNS: announced {service_name}")
            await self._shutdown.wait()
            await aiozc.async_unregister_service(info)
            await aiozc.async_close()
        except ImportError:
            logger.debug("zeroconf not installed — mDNS announce disabled")
        except Exception as e:
            logger.warning(f"mDNS announce failed: {e}")

    async def _reconnect_watch(self):
        """Monitor connection and attempt reconnect if dropped."""
        while not self._shutdown.is_set():
            await asyncio.sleep(15)
            if not self._connected.is_set():
                logger.info("ACC connection lost — attempting reconnect")
                try:
                    await self._connect()
                    # Re-request manifest after reconnect
                    await self._send({
                        "type": "REGISTER",
                        "payload": {
                            "agent_id": self.config.agent_id,
                            "session_reconnect": True,
                            "last_manifest_version": self._manifest_version
                        }
                    })
                except Exception as e:
                    logger.error(f"Reconnect failed: {e}")

    async def _auto_resume(self, resume_at_iso: str):
        from datetime import datetime, timezone
        resume = datetime.fromisoformat(resume_at_iso.replace("Z", "+00:00"))
        now = datetime.now(timezone.utc)
        wait = (resume - now).total_seconds()
        if wait > 0:
            await asyncio.sleep(wait)
        self._paused = False
        logger.info("ACC PAUSE expired — resuming")
```

---

### `relay.py`

```python
import asyncio
import logging
import time
from typing import Any, Dict, Optional
from .kernel import ACCKernel

logger = logging.getLogger("acc_relay")


class ToolRelayInterceptor:
    """
    Wraps every tool invocation in OpenClaw.
    Validates against the live ACC manifest before execution.
    Sends audit logs to ACC after each call.

    This is the enforcement layer — it runs AFTER manifest load-time
    filtering, ensuring that even mid-session revocations are honoured.
    """

    def __init__(self, kernel: ACCKernel):
        self.kernel = kernel

    def validate(self, tool_id: str, operation: str, params: Dict) -> "ValidationResult":
        """
        Check if a tool call should proceed.
        Returns a ValidationResult with allow=True/False and reason.
        """
        manifest = self.kernel.get_active_manifest()

        # No manifest at all — hard block
        if not manifest:
            return ValidationResult(
                allow=False,
                reason="no_manifest",
                message="No ACC manifest loaded — tool calls not permitted"
            )

        # Kernel paused
        if getattr(self.kernel, "_paused", False):
            return ValidationResult(
                allow=False,
                reason="agent_paused",
                message="Agent is paused by ACC"
            )

        # Tool not in manifest
        grant = self.kernel.get_tool_grant(tool_id)
        if not grant:
            return ValidationResult(
                allow=False,
                reason="tool_not_in_manifest",
                message=f"Tool '{tool_id}' not granted in current manifest"
            )

        # Check access level
        if grant["access_level"] == "none":
            return ValidationResult(
                allow=False,
                reason="access_level_none",
                message=f"Tool '{tool_id}' has access_level=none"
            )

        # Check operation is in allowed ops
        allowed_ops = grant.get("operations", [])
        if operation and not self._op_matches(operation, allowed_ops):
            return ValidationResult(
                allow=False,
                reason="operation_not_allowed",
                message=f"Operation '{operation}' not in allowed ops for '{tool_id}': {allowed_ops}"
            )

        # Check scope constraints
        scopes = grant.get("scopes", {})
        scope_violation = self._check_scopes(tool_id, operation, params, scopes)
        if scope_violation:
            return ValidationResult(
                allow=False,
                reason="scope_violation",
                message=scope_violation
            )

        return ValidationResult(allow=True, grant=grant)

    def _op_matches(self, operation: str, allowed_ops: list) -> bool:
        """Support wildcard ops like 's3:Get*', 'ec2:Describe*'."""
        for allowed in allowed_ops:
            if allowed.endswith("*"):
                if operation.startswith(allowed[:-1]):
                    return True
            elif operation == allowed:
                return True
        return False

    def _check_scopes(self, tool_id: str, operation: str,
                      params: Dict, scopes: Dict) -> Optional[str]:
        """
        Tool-specific scope enforcement.
        Extend this with per-tool validators as needed.
        Returns error string if violation, None if OK.
        """
        # GPIO pin whitelist
        if tool_id == "RASPI" and "pin" in params:
            allowed_pins = [int(p.strip()) for p in scopes.get("allowed_pins", "").split(",") if p.strip()]
            if allowed_pins and int(params["pin"]) not in allowed_pins:
                return f"GPIO pin {params['pin']} not in allowed list: {allowed_pins}"

        # AWS region check
        if tool_id == "AWS" and "region" in params:
            allowed_regions = [r.strip() for r in scopes.get("regions", "").split(",")]
            if allowed_regions and params["region"] not in allowed_regions:
                return f"AWS region '{params['region']}' not in allowed: {allowed_regions}"

        # AWS S3 bucket prefix check
        if tool_id == "AWS" and "bucket" in params:
            allowed_prefixes = [p.strip() for p in scopes.get("s3_buckets", "").split(",") if p.strip()]
            if allowed_prefixes:
                bucket = params["bucket"]
                if not any(bucket.startswith(p.replace("*", "")) for p in allowed_prefixes):
                    return f"S3 bucket '{bucket}' not in allowed prefixes: {allowed_prefixes}"

        # Web fetch blocked domains
        if tool_id == "WEBFETCH" and "url" in params:
            blocked = [d.strip().replace("*.", "") for d in scopes.get("blocked_domains", "").split(",") if d.strip()]
            url = params["url"].lower()
            for domain in blocked:
                if domain and domain in url:
                    return f"URL blocked by domain restriction: {domain}"

        # VOX transmit window
        if tool_id == "VOX" and operation == "transmit":
            tx_window = scopes.get("tx_window", "")
            if tx_window:
                from datetime import datetime
                import pytz
                now = datetime.now(pytz.timezone("Asia/Dubai"))
                current_time = now.strftime("%H:%M")
                try:
                    start, end = tx_window.replace(" GST", "").split("–")
                    if not (start <= current_time <= end):
                        return f"VOX transmit outside allowed window: {tx_window}"
                except Exception:
                    pass

        return None

    async def execute(self, tool_id: str, operation: str,
                      params: Dict, executor_fn) -> Any:
        """
        Main intercept point. Call this instead of tool executor directly.
        Validates, executes, logs result.
        """
        start = time.time()
        result = self.validate(tool_id, operation, params)

        if not result.allow:
            self.kernel.record_call(blocked=True)
            asyncio.create_task(self.kernel.send_tool_log("TOOL_CALL_BLOCKED", {
                "tool_id": tool_id,
                "operation": operation,
                "params": self._sanitize_params(params),
                "block_reason": result.reason,
                "message": result.message,
                "manifest_version": self.kernel._manifest_version
            }))
            logger.warning(f"BLOCKED tool={tool_id} op={operation} reason={result.reason}")
            raise ToolBlockedError(result.message)

        # Execute the real tool
        try:
            outcome = await executor_fn(tool_id, operation, params)
            duration = int((time.time() - start) * 1000)
            self.kernel.record_call(blocked=False)
            asyncio.create_task(self.kernel.send_tool_log("TOOL_CALL_LOG", {
                "tool_id": tool_id,
                "operation": operation,
                "params": self._sanitize_params(params),
                "outcome": "ok",
                "duration_ms": duration,
                "manifest_version": self.kernel._manifest_version
            }))
            return outcome

        except Exception as e:
            duration = int((time.time() - start) * 1000)
            self.kernel.record_call(blocked=False)
            asyncio.create_task(self.kernel.send_tool_log("TOOL_CALL_LOG", {
                "tool_id": tool_id,
                "operation": operation,
                "outcome": "error",
                "error": str(e),
                "duration_ms": duration,
                "manifest_version": self.kernel._manifest_version
            }))
            raise

    def _sanitize_params(self, params: Dict) -> Dict:
        """Remove sensitive values from params before logging."""
        sensitive_keys = {"password", "secret", "token", "key", "api_key",
                          "credential", "auth", "private"}
        return {
            k: "***" if any(s in k.lower() for s in sensitive_keys) else v
            for k, v in params.items()
        }


class ValidationResult:
    def __init__(self, allow: bool, reason: str = "", message: str = "", grant: dict = None):
        self.allow = allow
        self.reason = reason
        self.message = message
        self.grant = grant


class ToolBlockedError(Exception):
    """Raised when a tool call is blocked by the ACC relay."""
    pass
```

---

### `heartbeat.py`

```python
# Standalone module for background heartbeat stats collection
# Populated by the tool executor and read by kernel._heartbeat_loop

from dataclasses import dataclass, field
from threading import Lock
from typing import Dict

@dataclass
class AgentStats:
    calls_total: int = 0
    calls_blocked: int = 0
    calls_by_tool: Dict[str, int] = field(default_factory=dict)
    errors: int = 0
    _lock: Lock = field(default_factory=Lock, repr=False)

    def record(self, tool_id: str, blocked: bool = False, error: bool = False):
        with self._lock:
            self.calls_total += 1
            if blocked:
                self.calls_blocked += 1
            if error:
                self.errors += 1
            self.calls_by_tool[tool_id] = self.calls_by_tool.get(tool_id, 0) + 1
```

---

## Patches to OpenClaw Core

### Patch 1: `openclaw/plugin_loader.py`

The only change is replacing the filesystem plugin scan with a manifest-driven loader.

```diff
--- a/openclaw/plugin_loader.py
+++ b/openclaw/plugin_loader.py
@@ -1,6 +1,8 @@
 import importlib
 import os
+import logging
 from pathlib import Path
+from typing import Optional
 
 PLUGIN_DIR = Path(__file__).parent / "plugins"
+logger = logging.getLogger("acc.plugin_loader")
 
@@ -14,12 +16,31 @@ def load_all_plugins() -> dict:
         plugin_map[name] = mod
     return plugin_map
 
+def load_from_manifest(manifest: Optional[dict], plugin_dir: Path = PLUGIN_DIR) -> dict:
+    """
+    ACC-native plugin loader.
+    Only loads plugins that are explicitly granted in the ACC manifest.
+    Plugins not in the manifest are never instantiated.
+    """
+    if not manifest:
+        logger.error("No ACC manifest — refusing to load any plugins")
+        return {}
+
+    granted_tool_ids = {t["tool_id"] for t in manifest.get("tools", [])}
+    plugin_map = {}
+
+    for tool_id in granted_tool_ids:
+        plugin_path = plugin_dir / f"{tool_id.lower()}.py"
+        if plugin_path.exists():
+            mod = importlib.import_module(f"openclaw.plugins.{tool_id.lower()}")
+            plugin_map[tool_id] = mod
+            logger.info(f"Plugin loaded: {tool_id}")
+        else:
+            logger.warning(f"Tool {tool_id} granted in manifest but no plugin found at {plugin_path}")
+
+    logger.info(f"Plugin loader complete: {len(plugin_map)}/{len(granted_tool_ids)} tools active")
+    return plugin_map
+
 def get_plugin(name: str, plugin_map: dict):
     return plugin_map.get(name)
```

---

### Patch 2: `openclaw/tool_executor.py`

Wraps the execute function with the relay interceptor.

```diff
--- a/openclaw/tool_executor.py
+++ b/openclaw/tool_executor.py
@@ -1,15 +1,57 @@
+import asyncio
+import logging
+from typing import Optional
 from openclaw.plugin_loader import get_plugin
+from openclaw.acc_kernel import ToolRelayInterceptor
+from openclaw.acc_kernel.relay import ToolBlockedError
+
+logger = logging.getLogger("acc.tool_executor")
+
+# Global relay interceptor — set during OpenClaw startup by ACC kernel init
+_relay: Optional[ToolRelayInterceptor] = None
+
+def set_relay(relay: ToolRelayInterceptor):
+    """Called by ACC kernel after manifest is received."""
+    global _relay
+    _relay = relay
+    logger.info("ACC relay interceptor registered")
 
-def execute(tool_id: str, operation: str, params: dict, plugin_map: dict):
+async def execute(tool_id: str, operation: str, params: dict, plugin_map: dict):
     """
-    Execute a tool by calling its plugin's run() function.
+    ACC-patched executor. All calls go through the relay interceptor.
+    Relay validates against live manifest, checks scopes, logs to ACC.
+    Raises ToolBlockedError if not permitted.
     """
-    plugin = get_plugin(tool_id, plugin_map)
-    if not plugin:
-        raise ValueError(f"No plugin found for tool: {tool_id}")
-    return plugin.run(operation, params)
+    if _relay is None:
+        # Relay not yet set — this should not happen in normal operation
+        # as plugin loader blocks until manifest is received
+        raise RuntimeError(
+            "ACC relay not initialised. This is a bug — "
+            "tool_executor.execute() called before ACC kernel started."
+        )
+
+    async def _real_execute(tool_id: str, operation: str, params: dict):
+        plugin = get_plugin(tool_id, plugin_map)
+        if not plugin:
+            raise ValueError(f"No plugin found for tool: {tool_id}")
+        # Support both sync and async plugin run() functions
+        result = plugin.run(operation, params)
+        if asyncio.iscoroutine(result):
+            return await result
+        return result
+
+    return await _relay.execute(
+        tool_id=tool_id,
+        operation=operation,
+        params=params,
+        executor_fn=_real_execute
+    )
+
+def execute_sync(tool_id: str, operation: str, params: dict, plugin_map: dict):
+    """
+    Synchronous wrapper for contexts that cannot use async.
+    Use execute() (async) wherever possible.
+    """
+    loop = asyncio.get_event_loop()
+    return loop.run_until_complete(execute(tool_id, operation, params, plugin_map))
```

---

### Patch 3: `openclaw/main.py` (startup sequence)

```diff
--- a/openclaw/main.py
+++ b/openclaw/main.py
@@ -1,18 +1,44 @@
+import asyncio
+import logging
 from openclaw.config import load_config
-from openclaw.plugin_loader import load_all_plugins
+from openclaw.plugin_loader import load_from_manifest
 from openclaw.tool_executor import execute
 from openclaw.chat import ChatLoop
+from openclaw.acc_kernel import ACCKernel, ACCConfig, ToolRelayInterceptor
+from openclaw.tool_executor import set_relay
+from openclaw.acc_meta_endpoint import start_meta_endpoint
+
+logging.basicConfig(level=logging.INFO)
+logger = logging.getLogger("openclaw")
 
 def main():
-    config = load_config()
-    plugins = load_all_plugins()
-    loop = ChatLoop(config, plugins)
-    loop.run()
+    asyncio.run(_main_async())
+
+async def _main_async():
+    config = load_config()
+
+    # ── ACC KERNEL INIT ──────────────────────────────────────────────────
+    # This MUST happen before anything else. The kernel blocks here until
+    # it has connected to the ACC server and received a signed manifest.
+    try:
+        acc_config = ACCConfig.from_file()
+    except FileNotFoundError as e:
+        logger.critical(str(e))
+        raise SystemExit(1)
+
+    kernel = ACCKernel(acc_config)
+    await kernel.start()      # Blocks until manifest received or raises
+
+    # ── RELAY + PLUGINS ───────────────────────────────────────────────────
+    relay = ToolRelayInterceptor(kernel)
+    set_relay(relay)           # Register relay with tool executor
+
+    manifest = kernel.get_active_manifest()
+    plugins = load_from_manifest(manifest)   # Manifest-driven, not filesystem scan
+
+    # ── META ENDPOINT ─────────────────────────────────────────────────────
+    # Exposes /acc/meta for network discovery (returns agent_id, model, status)
+    asyncio.create_task(start_meta_endpoint(acc_config, kernel))
+
+    # ── CHAT LOOP ─────────────────────────────────────────────────────────
+    loop = ChatLoop(config, plugins)
+    await loop.run_async()
 
 if __name__ == "__main__":
     main()
```

---

## New File: `openclaw/acc_meta_endpoint.py`

This lightweight HTTP endpoint is what the ACC discovery service hits during a network scan. It's how an unknown agent self-identifies.

```python
"""
Lightweight HTTP endpoint exposing agent metadata for ACC network discovery.
Runs on a separate port (default: same port as agent + /acc/meta).
"""
import asyncio
import json
import logging
from aiohttp import web
from .acc_kernel import ACCKernel
from .acc_kernel.config import ACCConfig

logger = logging.getLogger("acc.meta_endpoint")


async def start_meta_endpoint(config: ACCConfig, kernel: ACCKernel, port: int = 8080):
    """Start a minimal HTTP server that responds to /acc/meta."""

    async def handle_meta(request):
        manifest = kernel.get_active_manifest()
        return web.json_response({
            "agent_id": config.agent_id,
            "runtime": "openclaw-acc",
            "kernel_version": "1.0.0",
            "status": "paused" if getattr(kernel, "_paused", False) else "active",
            "manifest_version": kernel._manifest_version,
            "tools_count": len(manifest.get("tools", [])) if manifest else 0,
            "session_id": kernel._session_id
        })

    async def handle_health(request):
        return web.json_response({"ok": True})

    app = web.Application()
    app.router.add_get("/acc/meta", handle_meta)
    app.router.add_get("/health", handle_health)

    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, "0.0.0.0", port)
    await site.start()
    logger.info(f"ACC meta endpoint listening on :{port}/acc/meta")
```

---

## Configuration File: `acc_config.yaml.example`

```yaml
# OpenClaw-ACC Agent Configuration
# Copy to ~/.openclaw-acc/config.yaml and fill in your values.
# Set ACC_CONFIG_PATH env var to use a custom path.

# ── Required ──────────────────────────────────────────────────────────
acc_server: "wss://acc.techimbue.internal:9443"
agent_id: "AEGIS-05"
api_key: "sk-acc-your-key-here"

# ── mTLS (strongly recommended in production) ─────────────────────────
cert_path: "/etc/openclaw-acc/agent.pem"
key_path: "/etc/openclaw-acc/agent-key.pem"
ca_cert_path: "/etc/openclaw-acc/ca.crt"

# ── Manifest signature verification ──────────────────────────────────
acc_public_key_path: "/etc/openclaw-acc/acc_public.pem"

# ── Behaviour ─────────────────────────────────────────────────────────
heartbeat_interval: 10          # seconds between heartbeats
reconnect_attempts: 3           # retry count before giving up
reconnect_backoff_base: 2.0     # exponential backoff base (seconds)
manifest_ttl_warn_seconds: 300  # warn 5 min before manifest expires
mdns_announce: true             # broadcast on local network for discovery
log_tool_calls: true            # send all tool calls to ACC audit log
log_level: "INFO"               # DEBUG|INFO|WARNING|ERROR
```

---

## Fork Maintenance Guide

```bash
# Initial fork setup
git clone https://github.com/openclaw/openclaw.git openclaw-acc
cd openclaw-acc
git remote add upstream https://github.com/openclaw/openclaw.git
git checkout -b acc-main

# Add the kernel package
mkdir -p openclaw/acc_kernel
# ... copy kernel files ...

# Apply patches
git apply patches/plugin_loader.patch
git apply patches/tool_executor.patch
git apply patches/main.patch

# Pull upstream updates (periodic)
git fetch upstream
git rebase upstream/main
# Resolve any conflicts in the two patched files
# Kernel package should never conflict — it's new code

# Tag releases
git tag v1.0.0-acc
```

---

## Dependencies Added to `requirements.txt`

```
# ACC kernel additions (add to existing openclaw requirements.txt)
websockets>=12.0
cryptography>=42.0
pyyaml>=6.0
aiohttp>=3.9
zeroconf>=0.131.0      # optional: for mDNS announce/discovery
pytz>=2024.1           # for timezone-aware scope checks
```

---

## Testing the Fork

```bash
# Unit test: kernel starts and blocks without config
pytest openclaw/tests/test_acc_kernel.py

# Integration test: mock ACC server → agent → manifest → tool call
pytest openclaw/tests/test_acc_integration.py

# Test relay blocks correctly
pytest openclaw/tests/test_relay_interceptor.py

# Test manifest signature verification
pytest openclaw/tests/test_manifest_verify.py
```

### Key test cases

| Test | Expected |
|------|----------|
| Start without `acc_config.yaml` | `SystemExit(1)` with clear message |
| ACC server unreachable after 3 retries | `RuntimeError` — refuse to start |
| Manifest received with invalid signature | Manifest rejected, agent does not load tools |
| Tool call for non-granted tool | `ToolBlockedError` |
| Tool call with scope violation (wrong pin) | `ToolBlockedError` |
| Kill signal received | Agent logs reason and exits within 5s |
| Live manifest refresh mid-session | New tools available, revoked tools blocked immediately |
| Read-only grant attempts write operation | `ToolBlockedError` |

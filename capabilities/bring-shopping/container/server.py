import json
import logging
import os
import shutil
import signal
import subprocess
import sys
import threading
import time
from concurrent import futures
from typing import Any

import grpc

import capability_pb2
import capability_pb2_grpc

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
)
log = logging.getLogger("bring-shopping")

GRPC_PORT = 50051
MCP_TIMEOUT_SECONDS = 20
DISCOVERY_TOOL_NAME = "list_tools"

READ_ONLY_TOOLS = {
    "loadLists",
    "getDefaultList",
    "getItems",
    "getItemsDetails",
    "getAllUsersFromList",
    "getUserSettings",
    "loadTranslations",
    "loadCatalog",
    "getPendingInvitations",
}


class McpBridge:
    def __init__(self, mail: str, password: str):
        self._mail = mail
        self._password = password
        self._proc: subprocess.Popen[bytes] | None = None
        self._next_id = 1

    def start(self) -> None:
        cmd = ["bring-mcp"]
        env = os.environ.copy()
        env["MAIL"] = self._mail
        env["PW"] = self._password

        self._proc = subprocess.Popen(
            cmd,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env=env,
        )

        threading.Thread(target=self._drain_stderr, daemon=True).start()
        self._initialize()

    def close(self) -> None:
        if not self._proc:
            return

        try:
            self._proc.terminate()
            self._proc.wait(timeout=2)
        except Exception:
            self._proc.kill()
        finally:
            self._proc = None

    def _drain_stderr(self) -> None:
        if not self._proc or not self._proc.stderr:
            return
        for raw in self._proc.stderr:
            try:
                line = raw.decode("utf-8", errors="replace").rstrip()
                if line:
                    log.info("bring-mcp: %s", line)
            except Exception:
                continue

    def _initialize(self) -> None:
        init_result = self._send_request(
            "initialize",
            {
                "protocolVersion": "2024-11-05",
                "capabilities": {},
                "clientInfo": {
                    "name": "selu-bring-shopping-wrapper",
                    "version": "1.0.0",
                },
            },
        )
        if "error" in init_result:
            raise RuntimeError(f"MCP initialize failed: {init_result['error']}")

        self._send_notification("notifications/initialized", {})

    def call_tool(self, tool_name: str, args: dict[str, Any]) -> Any:
        result = self._send_request(
            "tools/call",
            {
                "name": tool_name,
                "arguments": args,
            },
        )
        if "error" in result:
            raise RuntimeError(str(result["error"]))
        return result.get("result")

    def list_tools(self) -> Any:
        result = self._send_request("tools/list", {})
        if "error" in result:
            raise RuntimeError(str(result["error"]))
        return result.get("result")

    def _send_notification(self, method: str, params: dict[str, Any]) -> None:
        message = {
            "jsonrpc": "2.0",
            "method": method,
            "params": params,
        }
        self._write_message(message)

    def _send_request(self, method: str, params: dict[str, Any]) -> dict[str, Any]:
        request_id = self._next_id
        self._next_id += 1

        message = {
            "jsonrpc": "2.0",
            "id": request_id,
            "method": method,
            "params": params,
        }
        self._write_message(message)

        deadline = time.time() + MCP_TIMEOUT_SECONDS
        while True:
            if time.time() > deadline:
                raise TimeoutError(f"Timeout waiting for MCP response for method '{method}'")

            incoming = self._read_message()
            if "id" not in incoming:
                continue
            if incoming["id"] == request_id:
                return incoming

    def _write_message(self, message: dict[str, Any]) -> None:
        if not self._proc or not self._proc.stdin:
            raise RuntimeError("MCP process is not running")

        payload = json.dumps(message).encode("utf-8")
        header = f"Content-Length: {len(payload)}\r\n\r\n".encode("ascii")
        self._proc.stdin.write(header)
        self._proc.stdin.write(payload)
        self._proc.stdin.flush()

    def _read_message(self) -> dict[str, Any]:
        if not self._proc or not self._proc.stdout:
            raise RuntimeError("MCP process is not running")

        content_length = None
        while True:
            line = self._proc.stdout.readline()
            if line == b"":
                raise RuntimeError("MCP process exited while waiting for headers")
            if line == b"\r\n":
                break

            decoded = line.decode("ascii", errors="ignore").strip()
            if decoded.lower().startswith("content-length:"):
                content_length = int(decoded.split(":", 1)[1].strip())

        if content_length is None:
            raise RuntimeError("Missing Content-Length header in MCP response")

        body = self._proc.stdout.read(content_length)
        if not body:
            raise RuntimeError("Empty MCP response body")

        return json.loads(body.decode("utf-8"))


def _recommended_policy(tool_name: str) -> str:
    return "allow" if tool_name in READ_ONLY_TOOLS else "ask"


def _normalize_discovery_payload(raw: Any) -> list[dict[str, Any]]:
    if not isinstance(raw, dict):
        raise RuntimeError("tools/list result must be an object")

    tools = raw.get("tools")
    if not isinstance(tools, list):
        raise RuntimeError("tools/list result must contain 'tools' array")

    normalized: list[dict[str, Any]] = []
    for item in tools:
        if not isinstance(item, dict):
            continue

        name = item.get("name")
        if not isinstance(name, str) or not name.strip():
            continue

        description = item.get("description")
        if not isinstance(description, str) or not description.strip():
            description = f"Invoke bring-mcp tool '{name}'."

        schema = item.get("inputSchema")
        if not isinstance(schema, dict):
            schema = {"type": "object", "properties": {}, "required": []}

        normalized.append(
            {
                "name": name,
                "description": description,
                "input_schema": schema,
                "recommended_policy": _recommended_policy(name),
            }
        )

    return normalized


class CapabilityServicer(capability_pb2_grpc.CapabilityServicer):
    def Healthcheck(self, request, context):
        binary = shutil.which("bring-mcp")
        if not binary:
            return capability_pb2.HealthResponse(
                ready=False,
                message="bring-mcp binary not found",
            )
        return capability_pb2.HealthResponse(ready=True, message="bring-shopping ready")

    def Invoke(self, request, context):
        tool = request.tool_name
        log.info("Invoke tool=%s", tool)

        try:
            args = json.loads(request.args_json) if request.args_json else {}
            if not isinstance(args, dict):
                return capability_pb2.InvokeResponse(error="args_json must be a JSON object")

            config = json.loads(request.config_json) if request.config_json else {}
            if not isinstance(config, dict):
                return capability_pb2.InvokeResponse(error="config_json must be a JSON object")

            if tool == DISCOVERY_TOOL_NAME:
                # Discovery should work without user credentials. bring-mcp only
                # validates env presence at startup, so dummy values are enough.
                mail = str(config.get("MAIL") or "discovery@example.com")
                password = str(config.get("PW") or "discovery")
                bridge = McpBridge(mail, password)
                bridge.start()
                try:
                    raw = bridge.list_tools()
                finally:
                    bridge.close()

                discovered = _normalize_discovery_payload(raw)
                return capability_pb2.InvokeResponse(
                    result_json=json.dumps(discovered).encode("utf-8")
                )

            mail = config.get("MAIL")
            password = config.get("PW")
            if not mail or not password:
                return capability_pb2.InvokeResponse(
                    error="Missing required credentials: MAIL and PW"
                )

            bridge = McpBridge(str(mail), str(password))
            bridge.start()
            try:
                result = bridge.call_tool(tool, args)
            finally:
                bridge.close()

            return capability_pb2.InvokeResponse(
                result_json=json.dumps(result).encode("utf-8")
            )

        except Exception as e:
            log.exception("Error during tool invocation")
            return capability_pb2.InvokeResponse(error=str(e))

    def StreamInvoke(self, request, context):
        resp = self.Invoke(request, context)
        if resp.error:
            yield capability_pb2.InvokeChunk(error=resp.error, done=True)
        else:
            yield capability_pb2.InvokeChunk(data=resp.result_json, done=True)


def serve():
    server = grpc.server(futures.ThreadPoolExecutor(max_workers=4))
    capability_pb2_grpc.add_CapabilityServicer_to_server(CapabilityServicer(), server)
    server.add_insecure_port(f"0.0.0.0:{GRPC_PORT}")
    server.start()
    log.info("Bring shopping capability listening on port %d", GRPC_PORT)

    def _shutdown(signum, frame):
        log.info("Shutting down...")
        server.stop(grace=5)
        sys.exit(0)

    signal.signal(signal.SIGTERM, _shutdown)
    server.wait_for_termination()


if __name__ == "__main__":
    serve()

"""
MYRAA Desktop Agent — DNS-Pinning Egress Forward Proxy.

Provides connection-time network security and DNS rebinding immunity for Chromium:
1. Binds exclusively to 127.0.0.1 on an OS-assigned ephemeral port (port 0).
2. Intercepts all HTTP requests and HTTPS CONNECT tunnels.
3. Multi-address DNS resolution (AF_UNSPEC) checking all A and AAAA records.
4. Fails closed on DNS errors, malformed targets, restricted IPs, and blocked ports.
5. Pins outbound TCP socket directly to a validated literal IP (zero rebinding window).
6. Bidirectional streaming without TLS decryption (end-to-end TLS security preserved).
"""

from __future__ import annotations

import asyncio
import ipaddress
import logging
import socket
from typing import Optional, Set, Tuple
from urllib.parse import urlsplit

logger = logging.getLogger("desktop_agent.egress_proxy")

# Disallowed danger and internal service ports (matching NetworkSecurityManager)
BLOCKED_PORTS: Set[int] = {
    21,     # FTP
    22,     # SSH
    23,     # Telnet
    25,     # SMTP
    53,     # DNS
    69,     # TFTP
    135,    # MS RPC
    137,    # NetBIOS
    138,    # NetBIOS
    139,    # NetBIOS
    445,    # SMB
    1433,   # MS SQL
    1521,   # Oracle DB
    3306,   # MySQL
    5432,   # PostgreSQL
    6379,   # Redis
    11211,  # Memcached
    27017,  # MongoDB
    28017,  # MongoDB Web
}

RESTRICTED_DOMAIN_SUFFIXES: Tuple[str, ...] = (
    ".localhost",
    ".local",
    ".internal",
    ".lan",
    ".corp",
    ".home",
    ".onion",
    ".test",
    ".example",
    ".invalid",
)


def is_ip_restricted(ip_str: str) -> Tuple[bool, str]:
    """
    Evaluates whether an IP address literal is restricted:
    Loopback, RFC 1918 private, link-local, cloud metadata, CGNAT,
    IPv4-mapped IPv6 loopback, ULA IPv6, multicast, reserved, unspecified.
    """
    if not ip_str:
        return True, "Empty IP address"

    clean_ip = ip_str.strip().lower().strip("[]")

    # IPv4-mapped IPv6 check (e.g. ::ffff:127.0.0.1)
    if clean_ip.startswith("::ffff:"):
        mapped = clean_ip[7:]
        try:
            v4 = ipaddress.IPv4Address(mapped)
            if v4.is_loopback or v4.is_private or v4.is_link_local:
                return True, f"IPv4-mapped IPv6 restricted address: {clean_ip}"
        except Exception:
            return True, f"Malformed IPv4-mapped IPv6 address: {clean_ip}"

    try:
        ip = ipaddress.ip_address(clean_ip)
    except Exception as e:
        return True, f"Invalid IP literal '{clean_ip}': {e}"

    if ip.is_loopback:
        return True, f"Loopback IP address: {ip}"
    if ip.is_private:
        return True, f"RFC 1918 / private IP address: {ip}"
    if ip.is_link_local:
        return True, f"Link-local IP address: {ip}"
    if ip.is_reserved:
        return True, f"IETF reserved IP address: {ip}"
    if ip.is_multicast:
        return True, f"Multicast IP address: {ip}"
    if ip.is_unspecified:
        return True, f"Unspecified IP address: {ip}"

    # Specific cloud metadata IP literals
    str_ip = str(ip)
    if str_ip in ("169.254.169.254", "169.254.169.253"):
        return True, f"Cloud metadata endpoint IP: {str_ip}"

    # Carrier-grade NAT (100.64.0.0/10)
    if isinstance(ip, ipaddress.IPv4Address):
        cgnat_net = ipaddress.ip_network("100.64.0.0/10")
        if ip in cgnat_net:
            return True, f"Carrier-Grade NAT IP address: {str_ip}"

    return False, "Public safe IP"


def is_host_restricted(host: str) -> Tuple[bool, str]:
    """
    Evaluates host string for immediate loopback, local domains, or IP literals.
    """
    if not host or not isinstance(host, str):
        return True, "Missing or invalid host"

    h = host.strip().lower().strip("[]")

    if h in ("localhost", "127.0.0.1", "::1", "0.0.0.0", "::"):
        return True, f"Restricted loopback host '{h}'"

    for suffix in RESTRICTED_DOMAIN_SUFFIXES:
        if h == suffix.lstrip(".") or h.endswith(suffix):
            return True, f"Restricted domain suffix in '{h}'"

    # Single-label non-dot names (internal LAN machines like 'router', 'my-pc')
    if "." not in h and ":" not in h:
        return True, f"Restricted intranet single-label host '{h}'"

    # Alternate numeric IP representations (dword, hex, octal)
    if h.isdigit():
        num = int(h)
        if 0 <= num <= 0xFFFFFFFF:
            decoded = f"{(num >> 24) & 255}.{(num >> 16) & 255}.{(num >> 8) & 255}.{num & 255}"
            return is_ip_restricted(decoded)
        return True, "Malformed numeric host"

    if h.startswith("0x") and len(h) <= 10:
        try:
            num = int(h, 16)
            if 0 <= num <= 0xFFFFFFFF:
                decoded = f"{(num >> 24) & 255}.{(num >> 16) & 255}.{(num >> 8) & 255}.{num & 255}"
                return is_ip_restricted(decoded)
        except ValueError:
            pass

    # Check if host is already an IP address
    try:
        ip = ipaddress.ip_address(h)
        return is_ip_restricted(str(ip))
    except ValueError:
        pass

    return False, "Host name valid for DNS inspection"


class DnsPinningProxy:
    """
    Async loopback-only forward proxy enforcing DNS resolution validation and
    outbound socket IP pinning.
    """

    def __init__(self, host: str = "127.0.0.1", port: int = 0) -> None:
        self.host = host
        self.requested_port = port
        self.server: Optional[asyncio.Server] = None
        self.port: int = 0
        self.active_tasks: Set[asyncio.Task] = set()
        self._closing: bool = False

    async def start(self) -> int:
        """Starts proxy on 127.0.0.1 with an OS-assigned ephemeral port."""
        self._closing = False
        self.server = await asyncio.start_server(
            self._handle_client,
            self.host,
            self.requested_port,
        )
        # Extract OS-assigned port from the bound socket
        sockets = self.server.sockets
        if not sockets:
            raise RuntimeError("Failed to bind egress proxy to local socket")
        self.port = sockets[0].getsockname()[1]
        logger.info(f"DNS-Pinning Egress Proxy bound to {self.host}:{self.port}")
        return self.port

    async def stop(self) -> None:
        """Gracefully shuts down proxy server and closes active client connections."""
        self._closing = True
        if self.server:
            self.server.close()
            await self.server.wait_closed()
            self.server = None

        # Cancel any ongoing pipe tasks
        for task in list(self.active_tasks):
            if not task.done():
                task.cancel()
        if self.active_tasks:
            await asyncio.gather(*self.active_tasks, return_exceptions=True)
            self.active_tasks.clear()

    async def _handle_client(
        self,
        client_reader: asyncio.StreamReader,
        client_writer: asyncio.StreamWriter,
    ) -> None:
        task = asyncio.current_task()
        if task:
            self.active_tasks.add(task)
            task.add_done_callback(lambda t: self.active_tasks.discard(t))

        try:
            line = await client_reader.readline()
            if not line:
                self._safe_close(client_writer)
                return

            req_line = line.decode("latin1", errors="replace").strip()
            parts = req_line.split(" ")
            if len(parts) < 3:
                self._safe_close(client_writer)
                return

            method, target, version = parts[0].upper(), parts[1], parts[2]

            if method == "CONNECT":
                await self._handle_connect(client_reader, client_writer, target)
            elif method in ("GET", "POST", "PUT", "DELETE", "HEAD", "OPTIONS", "PATCH"):
                await self._handle_http(client_reader, client_writer, method, target, version)
            else:
                client_writer.write(b"HTTP/1.1 405 Method Not Allowed\r\n\r\n")
                await client_writer.drain()
                self._safe_close(client_writer)
        except Exception:
            self._safe_close(client_writer)

    async def _handle_connect(
        self,
        client_reader: asyncio.StreamReader,
        client_writer: asyncio.StreamWriter,
        authority: str,
    ) -> None:
        """Handles HTTPS CONNECT tunneling with socket-level IP pinning."""
        # Read headers until empty line (\r\n\r\n)
        while True:
            hdr = await client_reader.readline()
            if not hdr or hdr in (b"\r\n", b"\n"):
                break

        # Parse host and port from authority (e.g. "example.com:443")
        if ":" in authority:
            host, port_str = authority.rsplit(":", 1)
            try:
                port = int(port_str)
            except ValueError:
                self._write_denied(client_writer, "Invalid target port")
                return
        else:
            host = authority
            port = 443

        if port in BLOCKED_PORTS:
            self._write_denied(client_writer, f"Target port {port} is restricted")
            return

        # Resolve and Pin Destination IP
        pinned_ip, error = await self.resolve_and_validate(host)
        if not pinned_ip:
            self._write_denied(client_writer, error or "Access Denied by Egress Policy")
            return

        # Establish TCP connection to the pinned IP literal
        try:
            remote_reader, remote_writer = await asyncio.open_connection(pinned_ip, port)
        except Exception:
            client_writer.write(b"HTTP/1.1 502 Bad Gateway\r\n\r\n")
            await client_writer.drain()
            self._safe_close(client_writer)
            return

        # Handshake established: 200 Connection Established
        client_writer.write(b"HTTP/1.1 200 Connection Established\r\n\r\n")
        await client_writer.drain()

        # Bidirectional raw byte tunneling
        await asyncio.gather(
            self._pipe(client_reader, remote_writer),
            self._pipe(remote_reader, client_writer),
            return_exceptions=True,
        )

    async def _handle_http(
        self,
        client_reader: asyncio.StreamReader,
        client_writer: asyncio.StreamWriter,
        method: str,
        target: str,
        version: str,
    ) -> None:
        """Handles standard HTTP methods with socket-level IP pinning."""
        parsed = urlsplit(target)
        host = parsed.hostname or ""
        port = parsed.port or 80

        # Read client headers
        headers = []
        host_header_found = False
        while True:
            hdr = await client_reader.readline()
            if not hdr or hdr in (b"\r\n", b"\n"):
                break
            headers.append(hdr)
            hdr_str = hdr.decode("latin1", errors="replace").lower()
            if hdr_str.startswith("host:"):
                host_header_found = True
                if not host:
                    h_val = hdr_str.split(":", 1)[1].strip()
                    if ":" in h_val:
                        host, p_str = h_val.split(":", 1)
                        if not parsed.port and p_str.isdigit():
                            port = int(p_str)
                    else:
                        host = h_val

        if not host:
            self._write_denied(client_writer, "Missing target host in HTTP request")
            return

        if port in BLOCKED_PORTS:
            self._write_denied(client_writer, f"Target port {port} is restricted")
            return

        pinned_ip, error = await self.resolve_and_validate(host)
        if not pinned_ip:
            self._write_denied(client_writer, error or "Access Denied by Egress Policy")
            return

        try:
            remote_reader, remote_writer = await asyncio.open_connection(pinned_ip, port)
        except Exception:
            client_writer.write(b"HTTP/1.1 502 Bad Gateway\r\n\r\n")
            await client_writer.drain()
            self._safe_close(client_writer)
            return

        # Reconstruct path and query for upstream request
        path = parsed.path or "/"
        if parsed.query:
            path += "?" + parsed.query

        remote_writer.write(f"{method} {path} {version}\r\n".encode("latin1"))
        for h in headers:
            remote_writer.write(h)
        remote_writer.write(b"\r\n")
        await remote_writer.drain()

        # Stream response back
        await asyncio.gather(
            self._pipe(client_reader, remote_writer),
            self._pipe(remote_reader, client_writer),
            return_exceptions=True,
        )

    async def _pipe(
        self,
        reader: asyncio.StreamReader,
        writer: asyncio.StreamWriter,
    ) -> None:
        try:
            while True:
                data = await reader.read(65536)
                if not data:
                    break
                writer.write(data)
                await writer.drain()
        except Exception:
            pass
        finally:
            self._safe_close(writer)

    async def resolve_and_validate(self, host: str) -> Tuple[Optional[str], Optional[str]]:
        """
        Resolves destination host using socket.getaddrinfo (AF_UNSPEC) checking ALL
        returned A and AAAA records.
        Returns (pinned_ip, None) on success, or (None, reason) on restriction/failure.
        """
        restricted, reason = is_host_restricted(host)
        if restricted:
            return None, reason

        clean_host = host.strip().lower().strip("[]")

        # If already IP literal and confirmed safe by is_host_restricted:
        try:
            ip = ipaddress.ip_address(clean_host)
            return str(ip), None
        except ValueError:
            pass

        # Multi-record DNS resolution via asyncio loop
        loop = asyncio.get_running_loop()
        try:
            addrinfo = await loop.getaddrinfo(
                clean_host,
                None,
                family=socket.AF_UNSPEC,
                type=socket.SOCK_STREAM,
            )
            if not addrinfo:
                return None, f"DNS resolution returned no records for '{clean_host}'"

            pinned_ip: Optional[str] = None
            for family, socktype, proto, canonname, sockaddr in addrinfo:
                ip_str = sockaddr[0]
                ip_rest, ip_reason = is_ip_restricted(ip_str)
                if ip_rest:
                    return None, f"DNS rebinding / SSRF denied: '{clean_host}' resolves to restricted IP ({ip_str}): {ip_reason}"
                if pinned_ip is None:
                    pinned_ip = ip_str

            if not pinned_ip:
                return None, f"No safe IP found for '{clean_host}'"

            return pinned_ip, None
        except Exception as e:
            return None, f"DNS resolution failed for '{clean_host}': {e}"

    def _write_denied(self, writer: asyncio.StreamWriter, reason: str) -> None:
        try:
            msg = f"HTTP/1.1 403 Forbidden\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\nAccess Denied: {reason}\r\n"
            writer.write(msg.encode("latin1"))
            # Drain synchronously or best-effort
            writer.close()
        except Exception:
            self._safe_close(writer)

    def _safe_close(self, writer: asyncio.StreamWriter) -> None:
        try:
            writer.close()
        except Exception:
            pass


# Global singleton proxy manager for tools_browser integration
_PROXY_LOCK = asyncio.Lock()
_ACTIVE_PROXY: Optional[DnsPinningProxy] = None


async def get_or_start_egress_proxy() -> int:
    """Retrieves existing proxy port or starts a new DnsPinningProxy instance."""
    global _ACTIVE_PROXY
    async with _PROXY_LOCK:
        if _ACTIVE_PROXY is not None and _ACTIVE_PROXY.server is not None:
            return _ACTIVE_PROXY.port

        proxy = DnsPinningProxy(host="127.0.0.1", port=0)
        port = await proxy.start()
        _ACTIVE_PROXY = proxy
        return port


async def stop_egress_proxy() -> None:
    """Stops the active proxy singleton."""
    global _ACTIVE_PROXY
    async with _PROXY_LOCK:
        if _ACTIVE_PROXY is not None:
            await _ACTIVE_PROXY.stop()
            _ACTIVE_PROXY = None

const std = @import("std");

pub fn build(b: *std.Build) void {
    const optimize = b.standardOptimizeOption(.{});

    // Target standalone wasm32-freestanding as required by extism/zig-pdk.
    const target = b.standardTargetOptions(.{
        .default_target = .{
            .cpu_arch = .wasm32,
            .os_tag = .freestanding,
            .abi = .musl,
        },
    });

    const pdk_module = b.dependency("extism_pdk", .{
        .target = target,
        .optimize = optimize,
    }).module("extism-pdk");

    const plugin = b.addExecutable(.{
        .name = "example-social-zig",
        .root_source_file = b.path("src/main.zig"),
        .target = target,
        .optimize = optimize,
    });

    // Export all `export fn` symbols and omit a traditional `_start` entrypoint.
    plugin.rdynamic = true;
    plugin.entry = .disabled;
    plugin.root_module.addImport("extism-pdk", pdk_module);

    b.installArtifact(plugin);

    // Also install directly into ../output/example-social-zig.wasm.
    const install_output = b.addInstallFile(
        plugin.getEmittedBin(),
        "../../output/example-social-zig.wasm",
    );
    b.getInstallStep().dependOn(&install_output.step);
}

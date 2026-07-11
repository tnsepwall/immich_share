module.exports = {
  hooks: {
    readPackage: (pkg) => {
      if (!pkg.name) {
        return pkg;
      }
      // make the exiftool binaries regular dependencies since Docker prod
      // images build with --no-optional to reduce image size. Both platform
      // variants are promoted (not just process.platform's) so the lockfile
      // comes out identical no matter which OS regenerates it - a lockfile
      // generated with a platform-conditional hook on Windows ships the .exe
      // and strips the .pl from Linux images, which breaks exiftool there.
      if (pkg.name === "exiftool-vendored") {
        for (const binaryPackage of [
          "exiftool-vendored.exe",
          "exiftool-vendored.pl",
        ]) {
          if (pkg.optionalDependencies[binaryPackage]) {
            pkg.dependencies[binaryPackage] =
              pkg.optionalDependencies[binaryPackage];
            delete pkg.optionalDependencies[binaryPackage];
          }
        }
      }
      return pkg;
    },
  },
};

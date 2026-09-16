package web

import (
	"embed"
	"io/fs"
)

//go:generate npm ci
//go:generate npm run build

//go:embed dist
var files embed.FS

func Assets() fs.FS {
	assets, err := fs.Sub(files, "dist")
	if err != nil {
		panic(err)
	}
	return assets
}
